use super::*;

pub(super) fn extended_tool_specs() -> Vec<Value> {
    vec![
        // ─── Host timing primitives ───
        // // Why two such trivial tools earn first-class MCP entries: grok
        // only has the shell as a sleep/clock surface today, and every
        // `sleep 5` invocation spins up a wsl.exe → bash → coreutils
        // chain ~50–200 ms of overhead, fights the autonomy gate, and
        // pollutes the terminal log. A direct host primitive replaces
        // that pipeline with one stdio round-trip.
        json!({
            "name": "get_session_info",
            "description": "Return ShellX's view of this tab's session: cwd, transport kind (local/wsl/ssh), wslDistro/sshHost/linuxHome when applicable, and tabId. Single tool call — no need to spawn a subagent or probe `fs_list_dir` to discover where you're running. Subagents inherit the same tab via SHELLX_HOST_MCP_TAB_ID env so they see the same values. Returns {cwd, transport, wslDistro?, sshHost?, linuxHome?, tabId, fileSystems}. IMPORTANT: native provider/ACP file tools operate in cwd on the selected local/WSL/SSH environment; ShellX host MCP fs_* tools always operate on the ShellX parent host filesystem, even in WSL/SSH provider tabs.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "clock_now",
            "description": "Return the current wall-clock time. Avoids the cost + autonomy-gate flow of shelling out to `date`. Returns {unix_ms: number, iso8601: string, tz_used: 'utc'|'local'}. ISO-8601 is RFC-3339 compatible; the `tz_used` echo confirms which timezone the formatter applied.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tz": {
                        "type": "string",
                        "enum": ["utc", "local"],
                        "default": "utc",
                        "description": "Timezone for the ISO-8601 rendering. `unix_ms` is timezone-independent regardless."
                    }
                }
            }
        }),
        json!({
            "name": "sleep_ms",
            "description": "Bounded async sleep on the host. Replaces `sleep N` shell invocations during /build flows that need to pace polling. Maximum 60_000 ms (60 s) — larger values are rejected so a misconfigured agent can't stall the MCP loop indefinitely. Returns {slept_ms: number} once the wait elapses.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ms": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 60000,
                        "description": "Milliseconds to sleep. Hard-capped at 60_000."
                    }
                },
                "required": ["ms"]
            }
        }),
        // ─── Cross-tab durable kv store (host_mem.rs) ───
        // Four tools backed by a single SQLite file at
        // `~/.shellx/memory.db`. Foundation for cross-session
        // subagent knowledge sharing — any subagent grok dispatches
        // sees the same namespace, so notes written in one tab are
        // visible from every other.
        json!({
            "name": "mem_set",
            "description": "Upsert a durable key/value into the cross-tab SQLite store at ~/.shellx/memory.db. Returns {ok:true, namespace, key}. Set ttl_ms (wall-clock millis) for a self-expiring entry; omit for permanent. Visible from every other grok tab and from any subagent dispatched via the Agent tool.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key":       {"type": "string", "description": "Key to write. Must be non-empty after trimming."},
                    "value":     {"type": "string", "description": "Value payload. Stored verbatim as TEXT."},
                    "namespace": {"type": "string", "description": "Logical bucket. Defaults to \"default\". Useful for sandboxing per-project or per-subagent state.", "default": "default"},
                    "ttl_ms":    {"type": ["number", "null"], "description": "Wall-clock time-to-live in milliseconds. If set, the row is invisible to mem_get/mem_list after `now + ttl_ms` and lazy-evicted on the next mem_get. Omit / null for never-expires."}
                },
                "required": ["key", "value"]
            }
        }),
        json!({
            "name": "mem_get",
            "description": "Read a durable value previously written by mem_set. Returns {found, value?, namespace, key, mtime_unix_ms, expires_at_unix_ms?}. Expired rows are GONE from this call's perspective — `found:false` is returned and the underlying row is lazy-deleted.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key":       {"type": "string", "description": "Key to fetch."},
                    "namespace": {"type": "string", "description": "Bucket to read from. Defaults to \"default\".", "default": "default"}
                },
                "required": ["key"]
            }
        }),
        json!({
            "name": "mem_list",
            "description": "List entries from the durable kv store, capped at 500 rows alphabetically by key. Optional `prefix` does a SQL LIKE 'prefix%' match (% and _ are escaped as literals). Returns {entries:[{key, value, mtime_unix_ms, expires_at_unix_ms?}], count}. Expired rows are filtered from the result but NOT deleted (run mem_get on the key to force lazy-evict).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "Bucket to enumerate. Defaults to \"default\".", "default": "default"},
                    "prefix":    {"type": "string", "description": "Optional key-prefix filter. Empty string returns every key in the namespace (up to the 500-row cap).", "default": ""}
                }
            }
        }),
        json!({
            "name": "mem_delete",
            "description": "Remove a single durable entry. Idempotent: returns {deleted: false} if no row existed, {deleted: true} if a row was removed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key":       {"type": "string", "description": "Key to delete."},
                    "namespace": {"type": "string", "description": "Bucket. Defaults to \"default\".", "default": "default"}
                },
                "required": ["key"]
            }
        }),
        // ─── Agent_kill + Agent_metrics ───
        // // `Agent_kill` is the SIGTERM-then-SIGKILL switch for runaway
        // subagents. `Agent_metrics` is an observability aggregate
        // (in-flight + finished) so the user can see fan-out shape at
        // a glance.
        // // Coordination: appended at the END of tool_specs so parallel
        // worktrees touching this file produce additive-only conflicts.
        json!({
            "name": "Agent_kill",
            "description": "Terminate a running subagent. Default `force=false` sends SIGTERM, then escalates to SIGKILL after 3s if the child is still alive. With `force=true` we go straight to SIGKILL. Idempotent — killing an already-terminal subagent is not an error; the response carries `was_running=false`. Returns {killed: bool, was_running: bool, status, subagent_id, pid?, force, escalation_after_ms?}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "subagent_id": {
                        "type": "string",
                        "description": "UUID returned by a prior Agent call."
                    },
                    "force": {
                        "type": "boolean",
                        "default": false,
                        "description": "Skip the graceful SIGTERM and go straight to SIGKILL (Unix) / taskkill /F (Windows)."
                    }
                },
                "required": ["subagent_id"]
            }
        }),
        json!({
            "name": "Agent_metrics",
            "description": "Aggregate stats over the in-memory subagent registry. Returns {running, completed, failed, total, total_elapsed_ms_p50, total_elapsed_ms_p95, success_rate}. Percentiles are nearest-rank over completed+failed elapsed times; null when no terminal rows exist yet. success_rate = completed / (completed + failed), null until at least one terminal row.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        json!({
            "name": "vision_describe",
            "description": "Send an image to xAI Grok multimodal vision and get back a text description. Useful for inspecting attached images, verifying shellX UI screenshots (paired with shellXagent GET /screenshot), and reading text from images. Uses the existing Grok OAuth token from ~/.grok/auth.json by default (run `grok login` first), then falls back to ShellX Vault key vault:xai/api-key, env GROK_VISION_API_KEY/XAI_API_KEY, or pass:xai/api-key. Provide either `path` / `image_path` (local image file, or a generated/session image path on the active ShellX WSL/SSH tab when using shellx-host-http) or `imageBase64` (data URL or raw base64). Optional `prompt` / `question`; defaults to a detailed description. Optional `model` override. Path must end in .png/.jpg/.jpeg/.webp/.gif/.bmp.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path to a local image file. Extension must be png/jpg/jpeg/webp/gif/bmp. One of `path`, `image_path`, or `imageBase64` is required."},
                    "image_path": {"type": "string", "description": "Alias for `path`, accepted for compatibility."},
                    "imageBase64": {"type": "string", "description": "Either a full data: URL (`data:image/png;base64,...`) or raw base64 with no prefix."},
                    "prompt": {"type": "string", "description": "Question or instruction about the image. Defaults to 'Describe this image in detail.'"},
                    "question": {"type": "string", "description": "Alias for `prompt`, accepted for compatibility."},
                    "maxTokens": {"type": "number", "description": "Cap on response tokens. Default 800."},
                    "max_tokens": {"type": "number", "description": "Alias for `maxTokens`, accepted for compatibility."},
                    "model": {"type": "string", "description": "Override the vision model. Default 'grok-4.3'. Other options on the account: 'grok-4.20-0309-non-reasoning', 'grok-4.20-0309-reasoning'. Probe `/v1/models` to see what's available."}
                }
            }
        }),
        // OAuth-token-backed xAI tools. Bearer JWT from
        // ~/.grok/auth.json (no api-key plumbing). Same auth grok uses
        // for chat, available to host-MCP tools that need /v1/* access.
        json!({
            "name": "voice_tts",
            "description": "Synthesize speech via xAI grok-tts using the OAuth bearer from ~/.grok/auth.json (run `grok login` first). Writes MP3 to out_path (default <cwd>/.shellx-out/tts-<ts>.mp3). Returns {path, bytes, voice, language}. Voices: eve, ara, rex, sal, leo, una. Languages: en (default), plus model-supported locales.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Text to synthesize (max 5000 chars)." },
                    "voice": { "type": "string", "description": "Voice id. Default 'eve'.", "enum": ["eve","ara","rex","sal","leo","una"] },
                    "language": { "type": "string", "description": "BCP-47 language code. Default 'en'." },
                    "out_path": { "type": "string", "description": "Absolute output path; must be inside HOME. Default <cwd>/.shellx-out/tts-<unix_secs>.mp3." }
                },
                "required": ["text"]
            }
        }),
        json!({
            "name": "x_search",
            "description": "Search X posts through xAI's server-side Responses API `x_search` tool using the existing Grok OAuth bearer from ~/.grok/auth.json. This is the compact cross-agent X handoff: it returns bounded answer text, at most 64 citations, at most 16 compact tool-call receipts, and xSearchCalls without forwarding a Grok transcript. Use it only when X posts/current X discussion are specifically relevant; for ordinary web pages use the active provider's native web search/fetch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural-language question or search request about X posts." },
                    "allowed_x_handles": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional handle allow-list, without @. Max 20. Cannot be combined with excluded_x_handles."
                    },
                    "excluded_x_handles": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional handle deny-list, without @. Max 20. Cannot be combined with allowed_x_handles."
                    },
                    "from_date": { "type": "string", "description": "Optional ISO date lower bound, YYYY-MM-DD." },
                    "to_date": { "type": "string", "description": "Optional ISO date upper bound, YYYY-MM-DD." },
                    "enable_image_understanding": { "type": "boolean", "default": false },
                    "enable_video_understanding": { "type": "boolean", "default": false },
                    "model": { "type": "string", "description": "Responses API model. Default grok-4.3." },
                    "max_answer_chars": { "type": "integer", "description": "Cap returned answer text. Default 6000.", "default": 6000 }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "voice_stt_v2",
            "description": "Transcribe audio via xAI grok-stt using the OAuth bearer from ~/.grok/auth.json (run `grok login` first). Multipart upload, returns the raw xAI response object (typically {text, language, duration, words[]}). Audio formats: mp3, wav, ogg/opus, webm, m4a/mp4, flac. Cap 30 MB.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "audio_path": { "type": "string", "description": "Absolute path to audio file. Must be inside HOME. Extension drives the MIME guess (mp3/wav/ogg/opus/webm/m4a/mp4/flac)." }
                },
                "required": ["audio_path"]
            }
        }),
        // goal_complete. Legacy compatibility completion tool. Only
        // valid when legacy `/goal` is active for the current tab. Re-reads the
        // scratchboard (goal.md or plan.md) and rejects unless every Phase
        // is marked DONE and every `- [ ]` sub-stage is flipped to `- [x]`.
        // On reject, returns MCP error with a specific list of unchecked
        // items so grok knows what to finish + retry. On accept, marks
        // the per-tab goal state inactive (no further auto-continues).
        json!({
            "name": "goal_complete",
            "description": "Legacy compatibility only. Prefer build_complete for new shellX long-horizon work. Mark the active legacy /goal complete. REQUIRES that every Phase in the scratchboard (goal.md or plan.md in the session cwd) shows `status: DONE` AND every `- [ ]` sub-stage is flipped to `- [x]`. The tool re-reads the file and REJECTS the call with an error listing every unchecked item if anything is still pending — you cannot self-mark complete by writing to the file alone. Only callable when legacy `/goal` mode is on for the tab.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "Short summary of what was delivered. Surfaces in the UI and the audit log. Not validated against the scratchboard — the scratchboard checkboxes are the proof."
                    }
                },
                "required": ["summary"]
            }
        }),
        json!({
            "name": "build_receipt",
            "description": "Record a /build audit receipt for the active Build Mode run. Use for reviewer evidence, verifier evidence, blocker-opened, or blocker-resolved events when shellX cannot observe a stronger host signal.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["reviewCompleted", "verificationCompleted", "blockerOpened", "blockerResolved"],
                        "description": "Receipt kind to record."
                    },
                    "summary": {
                        "type": "string",
                        "description": "Short receipt summary."
                    },
                    "data": {
                        "type": "object",
                        "description": "Optional structured evidence details."
                    }
                },
                "required": ["kind", "summary"]
            }
        }),
        json!({
            "name": "build_state",
            "description": "Read the active /build run state for this tab: status, gates, blocker, scratchboard path, and current phase. Use before deciding the next build action.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." }
                }
            }
        }),
        json!({
            "name": "build_receipts",
            "description": "Read /build audit receipts for this tab. Use to verify checkpoint/review/verification/preview gates before build_complete.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." }
                }
            }
        }),
        json!({
            "name": "build_checkpoint",
            "description": "Create a local git checkpoint for the active Build Mode run and record a trusted checkpointCreated receipt. This never pushes or mutates a remote.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "label": {
                        "type": "string",
                        "description": "Optional short checkpoint label."
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Optional repository cwd override. Omit to use the active tab cwd."
                    }
                }
            }
        }),
        json!({
            "name": "preview_start",
            "description": "Start or restart shellX Work Preview for the active tab. Use this tool, not Agent shell commands, for /build UI, web, HTML, Vite, Next, or Expo preview gates. It starts shellX-owned loopback static/web/Expo preview state and returns the preview state. After this succeeds, call preview_diagnose; if the state is failed or logs report missing Expo web dependencies such as react-dom/react-native-web, fix the project dependencies and retry preview_start.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": {
                        "type": "string",
                        "description": "Optional tab id override. Omit to use the active MCP tab."
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Optional project directory. Omit to use shellX's active session cwd."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["auto", "static", "web", "expo"],
                        "description": "Preview kind. Use auto unless the project type is known."
                    },
                    "entry": {
                        "type": "string",
                        "description": "Optional static HTML entry path relative to cwd, for example index.html or shellx-preview-test.html."
                    }
                }
            }
        }),
        json!({
            "name": "preview_state",
            "description": "Read current Work Preview state for this tab: status, URL, cwd, kind, command, and error. Use before restarting a preview.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." }
                }
            }
        }),
        json!({
            "name": "preview_logs",
            "description": "Read Work Preview stdout/stderr log tail for this tab. Use after preview_start fails or when the rendered app is stale.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." }
                }
            }
        }),
        json!({
            "name": "preview_diagnose",
            "description": "Run shellX Preview Doctor for the active tab. Use after preview_start for UI, web, HTML, Vite, Next, or Expo work. Returns preview URL, command, HTTP status, page title, server logs, pass/fail issues, and when possible a rendered first-page screenshotPath that can be passed directly to vision_describe. Static previews may also report browser/runtime events captured by shellX. For interactive web or Expo apps, also manually exercise important in-app tabs/buttons or ask for a targeted screenshot; Preview Doctor does not click through app flows by itself. For /build UI work, run this before build_complete and fix every reported error.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": {
                        "type": "string",
                        "description": "Optional tab id override. Omit to use the active MCP tab."
                    },
                    "browserEvents": {
                        "type": "array",
                        "description": "Optional browser events captured by shellX UI. Usually omitted by agents.",
                        "items": { "type": "object" }
                    }
                }
            }
        }),
        json!({
            "name": "build_complete",
            "description": "Mark the active /build run complete. shellX validates build.md and the host receipt gates before accepting. REJECTS if checklist items remain, a blocker is open, or required checkpoint/reviewer/verifier receipts are missing. For UI/web/app work, run preview_start, then preview_diagnose, and fix reported errors before calling this.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "One-paragraph summary of what was delivered."
                    },
                    "verification": {
                        "type": "string",
                        "description": "Short evidence summary for the final verification gate."
                    }
                },
                "required": ["summary"]
            }
        }),
    ]
}
