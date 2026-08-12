use super::*;

pub(super) fn core_tool_specs() -> Vec<Value> {
    vec![
        json!({
            "name": "capabilities_summary",
            "description": "Return a compact shellX capability map for this tab: preferred MCP prefixes, native tools to use/avoid, host tool categories, Agent personas, Work Preview flow, marketplace discovery, and /build gate rules. Call this directly before broad tool discovery; use search_tool only for exact schemas.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "model_instruction_cards",
            "description": "Return ShellX's user-directed model/tool instruction cards for Grok Imagine media, Codex CLI, Claude Code, Antigravity CLI, and ShellX host tools. Use before cross-provider handoff or named media/tool routing. ShellX does not silently route to another provider; failed preflight requires user-visible fallback approval.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "provider_adapters",
            "description": "Read Codex CLI, Claude Code, and Antigravity CLI adapter availability/version/last-run health from ShellX. Defaults to this tab's active provider-session transport when available; pass transport/wslDistro only for an explicit cross-transport preflight. Use with model_instruction_cards before proposing or executing a provider handoff.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." },
                    "transport": { "type": "string", "enum": ["local", "wsl", "ssh"], "description": "Optional explicit transport. Omit to infer from the tab's active provider session." },
                    "wslDistro": { "type": "string", "description": "Optional WSL distro when transport is wsl." },
                    "sshHost": { "type": "string", "description": "Optional SSH user@host when transport is ssh." },
                    "sshPort": { "type": "integer", "description": "Optional SSH port when transport is ssh." },
                    "sshKeyVaultRef": { "type": "string", "description": "Optional ShellX vault key reference for SSH identity selection. This is a non-secret reference, not a key path or key material." }
                }
            }
        }),
        json!({
            "name": "provider_sessions",
            "description": "Read active/recent provider-session state and stored native conversation ids for this tab. This is read-only; starting or aborting provider sessions remains a separate UI/debug API action.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." },
                    "transport": { "type": "string", "enum": ["local", "wsl", "ssh"], "description": "Optional explicit transport. Omit to use the tab's active/recent provider-session transport." },
                    "wslDistro": { "type": "string", "description": "Optional WSL distro when transport is wsl." },
                    "sshHost": { "type": "string", "description": "Optional SSH user@host when transport is ssh." },
                    "sshPort": { "type": "integer", "description": "Optional SSH port when transport is ssh." },
                    "sshKeyVaultRef": { "type": "string", "description": "Optional ShellX vault key reference for SSH identity selection. This is a non-secret reference, not a key path or key material." }
                }
            }
        }),
        json!({
            "name": "send_prompt_to_session",
            "description": "User-approved handoff to ShellX Grok/ACP. Use only when the user explicitly asks this agent to route work to Grok, Grok Imagine, or another ShellX session. If targetTabId is omitted from a provider tab, ShellX uses that same visible tab and starts/connects its Grok child if needed. This tool never chooses a fallback provider.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "Prompt to send to the target Grok/ACP session. Include the user's media/provider intent verbatim for Grok Imagine handoffs. ShellX queues the prompt and does not wait for media generation to finish." },
                    "targetTabId": { "type": "string", "description": "Optional connected Grok/ACP target tab id. Omit for same-tab provider handoff when the current user prompt explicitly names Grok/Grok Imagine." },
                    "userApproved": { "type": "boolean", "description": "Must be true only when the user explicitly requested this handoff/provider route." },
                    "reason": { "type": "string", "description": "Short audit reason, e.g. 'user asked Codex to generate with Grok Imagine'." }
                },
                "required": ["prompt", "userApproved"]
            }
        }),
        json!({
            "name": "send_prompt_to_provider",
            "description": "User-approved handoff to a ShellX provider CLI session such as Codex CLI, Claude Code, or Antigravity CLI. Use only when the user explicitly names or approves that provider. If targetTabId is omitted, ShellX uses the same visible tab and infers local/WSL/SSH execution context from that tab.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "providerId": { "type": "string", "enum": ["codex-cli", "claude-code", "antigravity-cli"], "description": "Provider CLI to start." },
                    "prompt": { "type": "string", "description": "Prompt to send to the provider CLI session. Include the user's provider/media intent verbatim." },
                    "targetTabId": { "type": "string", "description": "Optional ShellX tab id. Omit for same-tab handoff." },
                    "userApproved": { "type": "boolean", "description": "Must be true only when the user explicitly requested this provider route." },
                    "includeShellxTooling": { "type": "boolean", "description": "Optional target provider-session ShellX tooling control. Defaults true for generic coding-agent handoffs. false selects the existing off mode and does not inject ShellX host tooling." },
                    "timeoutMs": { "type": "integer", "description": "Provider run timeout in milliseconds. Defaults to 3600000. ShellX clamps named media handoffs such as GPT Image to at least 900000 ms; do not set shorter media timeouts." },
                    "persistSession": { "type": "boolean", "description": "Persist native provider conversation id for future resume. Defaults to false for one-shot handoffs." },
                    "resume": { "type": "boolean", "description": "Resume the stored provider conversation if one exists. Defaults to false." },
                    "reason": { "type": "string", "description": "Short audit reason, e.g. 'user asked Claude to generate with GPT Image 2 via Codex'." }
                },
                "required": ["providerId", "prompt", "userApproved"]
            }
        }),
        json!({
            "name": "shellx_health",
            "description": "Check shellX debug API liveness. Use before debug API-backed evidence reads when shellX state tools look unavailable.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "session_tooling",
            "description": "Read the active tab's Tools/Environment board snapshot: desired MCP servers, health rows, and session metadata. Use for MCP/tool status checks.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." }
                }
            }
        }),
        json!({
            "name": "environment",
            "description": "Read environment diagnostics for the tab: agent version, MCP health, feature-readiness rows for missing Local/WSL/SSH tooling, skills/plugins/instructions, trust, and trace availability where supported. Use first when preview/tooling/config looks wrong.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." },
                    "force": { "type": "boolean", "description": "Refresh diagnostics instead of using cached state.", "default": false },
                    "cwd": { "type": "string", "description": "Optional cwd override for diagnostics." }
                }
            }
        }),
        json!({
            "name": "grok_environment",
            "description": "Compatibility alias for environment. Reads Grok-native diagnostics where the selected tab supports them.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." },
                    "force": { "type": "boolean", "description": "Refresh diagnostics instead of using cached state.", "default": false },
                    "cwd": { "type": "string", "description": "Optional cwd override for diagnostics." }
                }
            }
        }),
        json!({
            "name": "event_log",
            "description": "Read recent shellX event frames for audit/debug evidence. Filter by tabId and sinceMs when checking what just happened.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit for all tabs." },
                    "allTabs": { "type": "boolean", "description": "When true, ignore the active MCP tab and return all tabs.", "default": false },
                    "limit": { "type": "number", "description": "Max events to return.", "default": 200 },
                    "sinceMs": { "type": "number", "description": "Only events newer than this unix-ms timestamp." }
                }
            }
        }),
        json!({
            "name": "fs_watch",
            "description": "Start a filesystem watch under the session cwd or /tmp. Events stream as notifications/message frames with shape {kind, path, t}. Use `process_list` or the debug-api WS to consume events when calling embedded; standalone test uses /tools/fs_watch + WebSocket on the published shellXagent loopback port.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to watch. Must be inside session cwd or under /tmp." },
                    "recursive": { "type": "boolean", "description": "Watch sub-directories (default true).", "default": true },
                    "debounce_ms": { "type": "number", "description": "Coalesce rapid bursts (default 100).", "default": 100 }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "fs_unwatch",
            "description": "Stop a filesystem watch previously started with fs_watch. Pass either the original path or the returned watchId.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute watched path." },
                    "watchId": { "type": "string", "description": "watchId returned by fs_watch." }
                }
            }
        }),
        json!({
            "name": "process_list",
            "description": "List child processes tracked by this host MCP process registry, including Agent subprocesses and host-managed preview/tool tasks available to this MCP instance. Returns taskId, pid, cmd, started_at_ms, status, cpu_pct, rss_kb.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "process_signal",
            "description": "Send a Unix signal to a process registered by ShellX. Refuses unknown taskIds — this is the safety boundary. Supported: SIGTERM, SIGINT, SIGKILL, SIGHUP, SIGUSR1. Windows accepts only SIGTERM/SIGKILL (mapped to taskkill).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "signal": {
                        "type": "string",
                        "enum": ["SIGTERM", "SIGINT", "SIGKILL", "SIGHUP", "SIGUSR1"]
                    }
                },
                "required": ["taskId", "signal"]
            }
        }),
        json!({
            "name": "process_stats",
            "description": "Extended stats for one tracked process: cpu_pct, rss_kb, vsz_kb, threads, open_fds, start_ms, uptime_ms.",
            "inputSchema": {
                "type": "object",
                "properties": { "taskId": { "type": "string" } },
                "required": ["taskId"]
            }
        }),
        json!({
            "name": "process_attach_stdout",
            "description": "Return up to `tail_lines` recent stdout+stderr lines for the task. Does NOT kill the process if the agent disconnects. Live streaming is exposed over the debug-api WS for now; the tool itself returns the snapshot tail.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "tail_lines": { "type": "number", "default": 200 }
                },
                "required": ["taskId"]
            }
        }),
        json!({
            "name": "secret_get",
            "description": "Agent-facing secret retrieval is metadata/request-only. `vault:<key>` never reveals raw plaintext; ShellX uses grant-aware mediated injection/fill paths for Vault secrets. `pass:<path>` and bare legacy pass-store references are also denied here so agents cannot bypass the Vault Request Center. Returns structured error code=RAW_SECRET_REVEAL_DENIED or LEGACY_PASS_REVEAL_DENIED; use vault_list plus vault_request_grant for approved mediated use.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Secret reference. Raw reveal is denied for `vault:`, `pass:`, and bare legacy references; use mediated Vault tools." } },
                "required": ["path"]
            }
        }),
        json!({
            "name": "secret_set",
            "description": "Create a value through the active integrated ShellX Vault backend. Agent writes are confined to the `agent/` namespace and are create-only: an existing item is never overwritten. A missing `agent/` prefix is added automatically. WRITE-ONLY — `pass:` paths are rejected and the value is never echoed back. Use this for agent-managed scratch values; add production secrets through ShellX Settings → Vault.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "Agent-managed Vault key. `agent/` is added when omitted; case-sensitive." },
                    "value": { "type": "string", "description": "Plaintext value to encrypt and store." }
                },
                "required": ["key", "value"]
            }
        }),
        json!({
            "name": "secret_delete",
            "description": "Remove a value previously created through the Host MCP agent-managed namespace. Operator-created, user-only, and non-agent Vault entries are refused. A missing `agent/` prefix is added automatically. The operation is idempotent for absent agent-managed keys and never returns a value.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "Vault key to delete." }
                },
                "required": ["key"]
            }
        }),
        json!({
            "name": "vault_list",
            "description": "List agent-visible ShellX Vault references for planning. Returns key names and user-authored descriptions only; never returns secret values. Entries marked user-only in Settings are hidden. Use this before asking the user for a grant or choosing between existing tools/secrets.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "prefix": { "type": "string", "description": "Optional key prefix filter, e.g. `providers.` or `connections/`." }
                }
            }
        }),
        json!({
            "name": "vault_list_grants",
            "description": "List ShellX Vault grant metadata/status for planning and polling. Returns grant ids, secret/resource refs, scopes, operations, approval/revocation state, and expiry only; never returns secret values. Use after vault_request_grant to see whether the ShellX operator approved, denied/revoked, or left the grant pending.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "secretRef": { "type": "string", "description": "Optional exact secret/resource reference filter." },
                    "status": { "type": "string", "enum": ["pending", "approved", "active", "revoked"], "description": "Optional client-side status filter." }
                }
            }
        }),
        json!({
            "name": "vault_request_grant",
            "description": "Create a pending ShellX Vault grant request for operator approval. This tool cannot approve or reveal a secret. Browser fill/profile/email-code/wallet requests must include the exact current http/https origin and remain bound to it after approval. After it returns, the request appears in the ShellX Vault Request Center; poll vault_list_grants and use the mediated tool only after approved=true. RawReveal requests are refused from MCP.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "secretRef": { "type": "string", "description": "Vault secret/resource reference discovered through vault_list." },
                    "operation": { "type": "string", "enum": ["fill", "profileFill", "emailCodeRead", "agentWalletUse", "injectEnv", "providerUse", "connectorUse", "deposit"], "description": "Mediated operation the grant will authorize after approval." },
                    "actorScope": { "type": "object", "description": "Optional explicit GrantScope object, e.g. {kind:'browserOrigin', origin:'https://example.com'} or {kind:'allShellxAgents'}. For kind=agent, ShellX replaces any supplied agentId with the authenticated Host MCP session identity." },
                    "actorKind": { "type": "string", "enum": ["allShellxAgents", "agent", "provider", "workspace", "browserOrigin", "connector"], "description": "Optional shorthand actor scope kind when actorScope is omitted. Defaults to allShellxAgents." },
                    "agentId": { "type": "string", "description": "Ignored for actorKind=agent; ShellX derives the agent identity from the authenticated Host MCP session." },
                    "providerId": { "type": "string" },
                    "workspace": { "type": "string" },
                    "origin": { "type": "string", "description": "Exact scheme://host[:port] binding. Required for fill, profileFill, emailCodeRead, and agentWalletUse." },
                    "connectorId": { "type": "string" },
                    "expiresAtMs": { "type": "integer", "description": "Optional absolute expiry timestamp in epoch milliseconds." }
                },
                "required": ["secretRef", "operation"]
            }
        }),
        json!({
            "name": "vault_agent_request",
            "description": "Request or inspect a digest-bound executable run with selected ShellX Vault resources injected as environment variables. The tool never approves a request or reveals plaintext. action=request queues the exact absolute program, args, cwd, and bindings for trusted operator review in ShellX; after approval the command runs on the ShellX desktop host, not the active SSH/WSL target. Inline shell/interpreter evaluation and loader-altering environment names are refused. action=list returns metadata and redacted results; action=cancel may cancel only this ShellX host session's pending request.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["request", "list", "cancel"], "default": "list" },
                    "actorLabel": { "type": "string", "description": "Human-readable requester label shown to the operator." },
                    "purpose": { "type": "string", "description": "Why this exact executable needs the selected resources." },
                    "program": { "type": "string", "description": "Absolute executable path on the ShellX desktop host. Shell command strings are not accepted." },
                    "args": { "type": "array", "items": { "type": "string" } },
                    "cwd": { "type": "string", "description": "Optional absolute working directory on the ShellX desktop host." },
                    "bindings": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "resourceId": { "type": "string", "description": "Agent-visible resource id from vault_list; optional vault: prefix is removed." },
                                "env": { "type": "string", "description": "Environment variable receiving the value only inside the approved child process." }
                            },
                            "required": ["resourceId", "env"]
                        }
                    },
                    "requestId": { "type": "string", "description": "Pending request id for action=cancel." },
                    "timeoutMs": { "type": "integer", "description": "Execution timeout after approval; maximum 900000 ms." }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "vault_generate",
            "description": "Generate a password inside the agent-managed `agent/` Vault namespace and store it create-only without revealing it to the agent. A missing `agent/` prefix is added automatically and existing items are never overwritten. Use a separately approved mediated Browser/Vault fill to apply the stored item.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "origin": { "type": "string", "description": "Origin where the generated password will be used." },
                    "itemId": { "type": "string", "description": "New agent-managed Vault item reference to create. `agent/` is added when omitted; existing items are refused." },
                    "length": { "type": "integer", "minimum": 8, "maximum": 128, "description": "Generated password length; defaults to 24." },
                    "includeUpper": { "type": "boolean", "description": "Include uppercase characters; defaults to true." },
                    "includeDigits": { "type": "boolean", "description": "Include digits; defaults to true." },
                    "includeSymbols": { "type": "boolean", "description": "Include symbols; defaults to true." }
                },
                "required": ["origin", "itemId"]
            }
        }),
        json!({
            "name": "vault_deposit",
            "description": "Create write-only Vault deposit route metadata through ShellX Browser. The caller must POST the captured secretValue to the returned /browser/vault-deposits route from the browser/vault bridge; do not echo durable secrets through chat transcript text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "label": { "type": "string" },
                    "sourceUrl": { "type": "string" },
                    "taskId": { "type": "string" }
                },
                "required": ["label"]
            }
        }),
        json!({
            "name": "security_scan",
            "description": "Inventory dependency manifests/lockfiles under the session cwd and optionally run fixed local advisory-backed package audits. This is a bounded environment health check, not a full code scan: it looks for package security surfaces and uses locally installed tools such as pnpm/npm audit, cargo audit, govulncheck, or osv-scanner when requested. It never pushes or mutates remotes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute directory to scan. Defaults to the host MCP cwd. Must be inside cwd unless allow_outside_cwd=true."
                    },
                    "run_audits": {
                        "type": "boolean",
                        "default": false,
                        "description": "When true, run local audit tools where matching lockfiles and commands are available. Default false performs inventory only."
                    },
                    "max_depth": {
                        "type": "integer",
                        "default": 4,
                        "description": "Directory recursion cap for manifest inventory. Clamped to 1..12."
                    },
                    "max_manifests": {
                        "type": "integer",
                        "default": 80,
                        "description": "Maximum manifest/lockfile records returned. Clamped to 1..500."
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "default": 60000,
                        "description": "Per-audit command timeout. Clamped to 1s..180s."
                    },
                    "allow_outside_cwd": {
                        "type": "boolean",
                        "default": false,
                        "description": "Permit scanning an absolute directory outside the MCP cwd. Use only when the user explicitly points to that path."
                    }
                }
            }
        }),
        // ─── `Agent` family ───
        // Spawns a fresh `grok -p` subprocess with a persona system
        // prompt prepended to the user task. Concurrent by design: /build
        // uses this for reviewer/verifier fan-out and explicit long-running
        // work where Grok's native command set is not enough.
        json!({
            "name": "Agent",
            "description": agent_tool_description(),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "subagent_type": {
                        "type": "string",
                        "enum": crate::subagent::PERSONA_NAMES,
                        "description": agent_subagent_type_description()
                    },
                    "task": {
                        "type": "string",
                        "description": "The task for the subagent. Will be appended to the persona's system prompt with a `\\n\\n---\\n\\n` separator before being sent to `grok -p`. Be specific — the subagent has no other context."
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Optional working directory the spawned grok will operate in. Defaults to the active /build cwd when Build Mode is running, then the parent tab session cwd, then the host MCP server process cwd."
                    },
                    "wait": {
                        "type": "boolean",
                        "default": true,
                        "description": "When true (default): block until the subagent exits and return its final stdout. When false: return immediately with `{subagent_id, status: 'running'}` so the parent can fan out and poll later via Agent_status / Agent_output."
                    },
                    "ledger_dir": {
                        "type": "string",
                        "description": "Optional absolute directory path. When set, shellX atomically writes `<ledger_dir>/<subagent_id>.md` containing persona + task preview + ISO dispatch timestamp + status=running. Use this from `/build` (set to the run scratch directory's subagents folder) so the parent grok never has to write the initial ledger row from its own write_text_file path — avoids Windows file-lock contention on parallel fan-out. Rejected if relative, contains '..', or is empty."
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "default": crate::subagent::DEFAULT_SUBAGENT_TIMEOUT_MS,
                        "description": "Legacy alias. For wait=true, maximum time the parent waits before returning a still-running Agent handle; shellX does not kill an active subagent when this budget expires. For wait=false, legacy detached watchdog budget. Prefer wait_budget_ms plus explicit max_runtime_ms."
                    },
                    "wait_budget_ms": {
                        "type": "integer",
                        "default": crate::subagent::DEFAULT_SUBAGENT_TIMEOUT_MS,
                        "description": "How long the Agent tool call should wait for final output before returning a still-running subagent handle. This is not a kill timeout. Clamped to 24 hours."
                    },
                    "max_runtime_ms": {
                        "type": "integer",
                        "description": "Optional explicit hard wall-clock runtime cap for the subagent process. When omitted with wait=false, shellX applies the detached watchdog default. When omitted with wait=true, shellX does not kill the subagent just because the wait budget expires. Clamped to 7 days."
                    }
                },
                "required": ["subagent_type", "task"]
            }
        }),
        json!({
            "name": "Agent_status",
            "description": "Poll a running subagent for status without consuming its output. Cheap to call in a loop (no stdout payload). Returns {subagent_id, persona, status: 'running'|'completed'|'failed', elapsed_ms, total_tokens?, exit_code?}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "subagent_id": {
                        "type": "string",
                        "description": "UUID returned by a prior Agent call with wait=false."
                    }
                },
                "required": ["subagent_id"]
            }
        }),
        json!({
            "name": "Agent_output",
            "description": "Fetch stdout/stderr captured from a subagent. Outside Build Mode, wait_for_complete=true (default) blocks until the child finishes, capped at 30 minutes. During an active /build run, shellX never blocks on a still-running child here; it returns a running snapshot with wait_for_complete_deferred=true so the parent can keep polling with Agent_status/Agent_output. When wait_for_complete=false, returns the current captured snapshot plus a still_running flag.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "subagent_id": {
                        "type": "string",
                        "description": "UUID returned by a prior Agent call with wait=false."
                    },
                    "wait_for_complete": {
                        "type": "boolean",
                        "default": true,
                        "description": "Block until the subagent finishes (true, default), or return what's captured so far (false)."
                    }
                },
                "required": ["subagent_id"]
            }
        }),
        // Batch poll: replaces a manual loop of N Agent_status calls
        // with one call that returns the full snapshot. Saves 15+
        // sequential polls per build fan-out cycle.
        json!({
            "name": "Agent_poll_all",
            "description": "Batch poll: given a list of subagent_ids, return a status snapshot for each in one call. Does NOT block — if nothing has changed, returns the snapshot immediately. Per-id shape matches Agent_status. Use after parallel Agent fan-out to avoid issuing one Agent_status per child.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "subagent_ids": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_AGENT_POLL_ALL_IDS,
                        "items": {"type": "string"},
                        "description": "UUIDs returned by prior Agent calls with wait=false."
                    }
                },
                "required": ["subagent_ids"]
            }
        }),
        // fs primitives: byte-size proof shouldn't require read_file
        // on huge artifacts; fs_stat is the lighter primitive.
        // fs_exists for cheap branching. fs_ensure_dir for safe mkdir
        // before write.
        json!({
            "name": "fs_exists",
            "description": "Returns {exists: bool, kind: 'file'|'dir'|'symlink'|null}. Cheap. Use to branch before a read/write.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path on the host filesystem."}
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "fs_stat",
            "description": "Returns {exists, kind, size_bytes, mtime_unix_ms} for a path. Use for G1 byte-size proof without reading the whole file.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path on the host filesystem."}
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "fs_ensure_dir",
            "description": "Create a directory and all missing parents (mkdir -p). Idempotent — no error if the path already exists as a directory. Returns {created: bool, path: <abs>}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path of the directory to create."}
                },
                "required": ["path"]
            }
        }),
        // Native fs read/write/append/list_dir. grok's `write_text_file`
        // hits Windows file-lock contention on hot paths and AV
        // scanners; doing the IO host-side with an atomic temp-then-
        // rename eliminates the partial-read window.
        json!({
            "name": "fs_read",
            "description": "Read one bounded UTF-8 text page from the ShellX parent host filesystem. In SSH/WSL provider tabs this does not read from the remote cwd; use native provider file tools for remote project files. Lossy-decodes invalid bytes so binary blobs don't error. Default 16 KiB; continue from next_offset_bytes instead of returning a whole large document. Returns {content, size_bytes, offset_bytes, bytes_returned, next_offset_bytes, truncated, approx_tokens}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path on the ShellX parent host filesystem."},
                    "offset_bytes": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "Byte offset at which to start this page. Omit for the first page; continue with the prior response's next_offset_bytes."
                    },
                    "max_bytes": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 1048576,
                        "description": "Maximum bytes in this page. Default 16384 (16 KiB), hard maximum 1048576 (1 MiB)."
                    }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "fs_read_binary",
            "description": "Read a ShellX parent-host file as raw bytes, return as base64. In SSH/WSL provider tabs this does not read from the remote cwd; use native provider file tools for remote project files. Use this for images, archives, binaries — anything that loses information through UTF-8-lossy decoding (the `fs_read` default). Cap 16 MiB; pass max_bytes to lower. Returns {content_base64, size_bytes, truncated, mime}. mime is sniffed from extension only (image/jpeg, image/png, application/zip, etc).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path on the ShellX parent host filesystem."},
                    "max_bytes": {
                        "type": "integer",
                        "description": "Maximum bytes to read. Default 16777216 (16 MiB). If the file is larger, the prefix is returned and `truncated` is true."
                    }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "fs_copy",
            "description": "Copy a file from src to dst on the ShellX parent host filesystem. In SSH/WSL provider tabs this is still the parent ShellX host, not the remote provider cwd. Atomic where the filesystem supports it (single rename within same FS); otherwise read+write. Default refuses to overwrite — set overwrite=true to allow. Set create_dirs=true to mkdir -p the dst parent. Returns {bytes_copied, src, dst, overwrite_used}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "src": {"type": "string", "description": "Absolute source path."},
                    "dst": {"type": "string", "description": "Absolute destination path."},
                    "overwrite": {"type": "boolean", "description": "Default false. True to clobber an existing destination."},
                    "create_dirs": {"type": "boolean", "description": "Default false. True to mkdir -p the dst parent."}
                },
                "required": ["src", "dst"]
            }
        }),
        json!({
            "name": "fs_delete",
            "description": "Delete a file or directory. Default refuses to descend into a non-empty directory — set recursive=true to remove the entire tree. Symlinks themselves are removed (the target is NOT followed). Returns {removed: true, kind, path}. Idempotent: if the path is missing, returns {removed: false, missing: true, path} (no error).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path of the entry to remove."},
                    "recursive": {"type": "boolean", "description": "Default false. True allows removing non-empty directories (rm -rf semantics, scoped to this single path)."}
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "fs_write",
            "description": "Atomic write on the ShellX parent host filesystem — content goes to <path>.<rand>.tmp then rename(2) onto <path>. In SSH/WSL provider tabs this does not write into the remote cwd; use native provider file tools for remote project files. Concurrent readers never see a partial file. Set create_dirs=true to mkdir -p the parent. For binary payloads (images, archives, any non-UTF-8 bytes) set encoding='base64' and pass base64-encoded content — bytes are decoded before writing. Returns {bytes_written, path, encoding}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute destination path on the ShellX parent host filesystem."},
                    "content": {"type": "string", "description": "Full file contents to write. UTF-8 by default; if encoding='base64' this is the base64-encoded form of the binary payload."},
                    "create_dirs": {
                        "type": "boolean",
                        "description": "If true, mkdir -p the parent directory before writing. Default false."
                    },
                    "encoding": {
                        "type": "string",
                        "enum": ["utf8", "base64"],
                        "description": "How to interpret `content` before writing. 'utf8' (default) writes the bytes as-is. 'base64' base64-decodes content first — use this for binary payloads that can't survive JSON's UTF-8 requirement."
                    }
                },
                "required": ["path", "content"]
            }
        }),
        json!({
            "name": "fs_append",
            "description": "Append-only write on the ShellX parent host filesystem. In SSH/WSL provider tabs this does not append inside the remote cwd; use native provider file tools for remote project files. Creates the file if missing. Returns {bytes_appended, new_size}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path of the ShellX parent host file to append to."},
                    "content": {"type": "string", "description": "Content to append (UTF-8)."}
                },
                "required": ["path", "content"]
            }
        }),
        json!({
            "name": "fs_list_dir",
            "description": "Non-recursive directory listing. Returns {entries: [{name, kind: 'file'|'dir'|'symlink', size_bytes, mtime_unix_ms}], truncated}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path of the directory to list."},
                    "max_entries": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": FS_LIST_HARD_MAX,
                        "description": "Cap on entries returned. Default 200. If the directory has more, the prefix is returned and `truncated` is true."
                    }
                },
                "required": ["path"]
            }
        }),
        // ─── fs_grep ───
        // // Regex over files. Replaces the pattern where grok spawns an
        // `Agent` subagent just to shell `grep -r` (~8-10 s per call).
        // Backed by ripgrep's
        // `ignore` crate so .gitignore / hidden-file rules are honored
        // by default. Single-threaded walk — for the typical project
        // tree (~thousands of files) this returns in <1 s. Hard cap on
        // file size (10 MB) + match count (200) keeps the response
        // bounded so an over-broad pattern can't blow up the agent
        // transcript.
        json!({
            "name": "fs_grep",
            "description": "Regex over files under a root path. Returns {matches: [{path, line, text, before?, after?}], files_scanned, truncated}. Skips binary files (null-byte heuristic), files >10MB, and respects .gitignore/.ignore by default. Use `glob` to narrow file selection (e.g. '*.rs'). `context_lines` includes N lines above/below each match.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex pattern. Use Rust regex syntax (similar to PCRE without lookbehind)."},
                    "path": {"type": "string", "description": "Absolute path of the root to search."},
                    "glob": {"type": "string", "description": "Optional file glob filter, e.g. '*.rs' or '**/*.md'. Default: all files."},
                    "case_insensitive": {"type": "boolean", "description": "Default false. Equivalent to wrapping pattern in (?i).", "default": false},
                    "max_matches": {"type": "integer", "minimum": 1, "maximum": FS_GREP_HARD_MAX_MATCHES, "description": "Cap on matches returned. Default 200; further matches set truncated=true and stop scanning.", "default": FS_GREP_DEFAULT_MAX_MATCHES},
                    "respect_gitignore": {"type": "boolean", "description": "Honor .gitignore/.ignore files. Default true.", "default": true},
                    "context_lines": {"type": "integer", "minimum": 0, "maximum": FS_GREP_HARD_MAX_CONTEXT_LINES, "description": "Lines of context around each match (above + below). Default 0.", "default": 0}
                },
                "required": ["pattern", "path"]
            }
        }),
        // ─── net_fetch ───
        // // Typed HTTP fetch with a per-host allow-list. Replaces grok's
        // pattern of shelling to `curl` for every external call, which
        // costs a process spawn, has zero allow-list, and routinely
        // dumps full response bodies into the agent transcript.
        // Allow-list lives at `~/.shellx/net_allow.toml`; the file
        // is auto-created on first run with the defaults documented in
        // SKILL-style help. Hosts can be exact (`github.com`) or globs
        // with a leading star (`*.githubusercontent.com`).
        json!({
            "name": "net_fetch",
            "description": "HTTP fetch against an allow-listed host. Replaces `curl` for grok — returns a typed {status, headers, body, body_bytes, content_type, truncated} envelope. POST/PUT/PATCH/DELETE require a body; Content-Type defaults to application/json. Response body is capped at `max_bytes` (default 5MB) with `truncated=true` on cap. Hosts must match `~/.shellx/net_allow.toml`; disallowed hosts return a structured error WITHOUT making the HTTP call.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Full URL including scheme. Host must match the allow-list."},
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], "default": "GET"},
                    "headers": {"type": "object", "description": "Extra request headers. Values must be strings.", "additionalProperties": {"type": "string"}},
                    "body": {"type": "string", "description": "Request body. Required for POST/PUT/PATCH/DELETE."},
                    "timeout_ms": {"type": "number", "default": 30000, "description": "Per-request timeout in milliseconds."},
                    "max_bytes": {
                        "type": "number",
                        "default": NET_FETCH_DEFAULT_MAX_BYTES,
                        "maximum": NET_FETCH_HARD_MAX_BYTES,
                        "description": "Cap on response body bytes read. Excess is dropped and `truncated=true`."
                    }
                },
                "required": ["url"]
            }
        }),
        // ─── search_tool ───
        // // Discovery aid for grok. The default tools/list response now
        // ships enough specs that Grok's planning prompt should not scan
        // them all by default. `search_tool` lets Grok query by substring
        // OR pull the full inventory in one shot via `full_inventory=true`.
        // The small default result set remains intentional so ordinary
        // searches do not dump the full tool catalog into every prompt.
        // `full_inventory` is retained for schema debugging; normal
        // planning should call capabilities_summary plus targeted queries.
        json!({
            "name": "search_tool",
            "description": "Search the host MCP tool inventory for exact schemas. Default: returns up to `limit` (5) matching specs ranked by query substring + a `total_hidden_tools` count. For broad orientation call capabilities_summary first. Pass `full_inventory=true` only for debugging exhaustive schema drift; it is large and may be stored by Grok as a session JSON artifact.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Case-insensitive substring matched against tool name + description. Omit (or empty) to list all in order.", "default": ""},
                    "limit": {"type": "number", "description": "Maximum specs to return when full_inventory=false. Default 5.", "default": 5},
                    "full_inventory": {"type": "boolean", "description": "When true, return EVERY tool spec. Debug-only; prefer capabilities_summary plus targeted search_tool queries for normal planning.", "default": false}
                }
            }
        }),
    ]
}
