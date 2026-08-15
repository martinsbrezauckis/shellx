use super::*;

const AGENT_VAULT_PREFIX: &str = "agent/";
const AGENT_VAULT_PROVIDER: &str = "shellx-agent-managed";

fn normalize_agent_vault_key(tool: &str, raw: &str) -> Result<String, String> {
    let raw = raw.strip_prefix("vault:").unwrap_or(raw).trim();
    if raw.is_empty() {
        return Err(format!("{tool}: key cannot be empty"));
    }
    if raw.len() > 240 || raw.chars().any(|ch| ch.is_control() || ch == '\\') {
        return Err(format!(
            "{tool}: key must be at most 240 characters and contain no control characters or backslashes"
        ));
    }
    if raw
        .split('/')
        .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(format!("{tool}: key contains an invalid path segment"));
    }
    Ok(if raw.starts_with(AGENT_VAULT_PREFIX) {
        raw.to_string()
    } else {
        format!("{AGENT_VAULT_PREFIX}{raw}")
    })
}

fn agent_vault_metadata_is_mutable(meta: &crate::shellx_vault::ShellxVaultKeyMeta) -> bool {
    !meta.user_only && meta.resource_provider.as_deref() == Some(AGENT_VAULT_PROVIDER)
}

/// secret_get — metadata/request-only secret lookup for agents.
///
/// Raw reveal is denied for both `vault:<key>` and legacy pass-store
/// references. Agents should use `vault_list` for planning, create a
/// `vault_request_grant`, then use a mediated ShellX injection/fill path.
pub(super) async fn tool_secret_get(args: Value) -> Result<Value, String> {
    // #438 — accept either `key` OR `path`. secret_set uses `key`, the
    // legacy spec for this tool used `path`; without dual-accept the
    // agent's set-then-get round-trip silently 404s with KEY_NOT_FOUND
    // because the get returns missing-param on `key`.
    let raw_path = args
        .get("key")
        .or_else(|| args.get("path"))
        .and_then(|v| v.as_str())
        .ok_or("secret_get: missing 'key' (or legacy 'path')")?
        .to_string();

    // Vault routing: vault:<key> diverts to the encrypted local
    // store before any pass / gpg-agent path is touched.
    if let Some(vault_key) = raw_path.strip_prefix("vault:") {
        return tool_secret_get_vault(vault_key).await;
    }

    let path = raw_path
        .strip_prefix("pass:")
        .map(|s| s.to_string())
        .unwrap_or(raw_path);

    // Basic shape check — no shell metacharacters.
    if path.chars().any(|c| "|;`$<>\n\"'\\".contains(c)) {
        return Err("secret_get: path contains forbidden characters".to_string());
    }

    Ok(json!({
        "code": "LEGACY_PASS_REVEAL_DENIED",
        "message": "legacy pass-store raw reveal is disabled for agents; import or reference the secret through ShellX Vault and request a mediated grant",
        "isError": true
    }))
}

/// `vault:<key>` resolver for the agent-facing MCP surface.
///
/// Raw reveal is denied by default. ShellX browser/provider/agent flows
/// should use mediated grant-aware injection/fill paths that avoid placing
/// plaintext in chat transcripts or tool results.
pub(super) async fn tool_secret_get_vault(key: &str) -> Result<Value, String> {
    if key.is_empty() {
        return Err("secret_get: vault key cannot be empty".to_string());
    }
    Ok(json!({
        "code": "RAW_SECRET_REVEAL_DENIED",
        "message": "raw Vault secret reveal requires explicit user approval; use mediated Vault fill or injection tools",
        "isError": true
    }))
}

/// Write a value into the shellX vault. Refuses `pass:`
/// and other namespaces; vault is the only safe write target from
/// inside an agent context (no GPG pinentry surprises).
pub(super) async fn tool_secret_set(args: Value) -> Result<Value, String> {
    // #438 — also accept `path` for symmetry with secret_get/delete.
    let key = args
        .get("key")
        .or_else(|| args.get("path"))
        .and_then(|v| v.as_str())
        .ok_or("secret_set: missing 'key' (or legacy 'path')")?
        .trim();
    let value = args
        .get("value")
        .and_then(|v| v.as_str())
        .ok_or("secret_set: missing 'value'")?;
    if key.is_empty() {
        return Err("secret_set: key cannot be empty".to_string());
    }
    if key.starts_with("pass:") {
        return Err("secret_set: writing to the pass-store from an agent context is refused — use shellX Settings or write to the vault: namespace instead".to_string());
    }
    // Agent-originated writes are confined to a dedicated namespace and are
    // create-only. Existing operator values can therefore never be replaced,
    // even in ShellX Full Auto.
    let key = normalize_agent_vault_key("secret_set", key)?;
    let backend = current_vault_backend_for_mutation().await?;
    let created = backend
        .compat_create_agent_managed(
            &key,
            value,
            Some("Created through ShellX Host MCP".to_string()),
        )
        .await
        .map_err(|e| format!("vault write failed: {}", e))?;
    if !created {
        return Ok(json!({
            "ok": false,
            "code": "VAULT_AGENT_KEY_EXISTS",
            "message": "secret_set is create-only and will not overwrite an existing Vault item",
            "key": key,
            "secretExposed": false,
            "isError": true
        }));
    }
    // CRITICAL: never echo the value back. Only confirmation + key.
    Ok(json!({
        "ok": true,
        "key": key,
        "status": "created",
        "namespace": AGENT_VAULT_PREFIX,
        "secretExposed": false
    }))
}

/// Remove a key from the vault. Idempotent: `existed`
/// reports whether the key was actually present before the call.
pub(super) async fn tool_secret_delete(args: Value) -> Result<Value, String> {
    // #438 — accept either `key` or `path` (legacy alias) for symmetry
    // with secret_get + secret_set.
    let key = args
        .get("key")
        .or_else(|| args.get("path"))
        .and_then(|v| v.as_str())
        .ok_or("secret_delete: missing 'key' (or legacy 'path')")?
        .trim();
    if key.is_empty() {
        return Err("secret_delete: key cannot be empty".to_string());
    }
    if key.starts_with("pass:") {
        return Err("secret_delete: removing pass-store entries from an agent context is refused — delete from a terminal with `pass rm <path>`".to_string());
    }
    let key = normalize_agent_vault_key("secret_delete", key)?;
    let backend = current_vault_backend_for_mutation().await?;
    let metadata = backend
        .compat_list_keys_with_meta(Some(&key))
        .await
        .map_err(|e| format!("vault metadata lookup failed: {e}"))?
        .into_iter()
        .find(|item| item.key == key);
    let Some(metadata) = metadata else {
        return Ok(json!({ "ok": true, "key": key, "existed": false, "secretExposed": false }));
    };
    if !agent_vault_metadata_is_mutable(&metadata) {
        return Ok(json!({
            "ok": false,
            "code": "VAULT_AGENT_DELETE_REFUSED",
            "message": "secret_delete may remove only values created through the agent-managed Host MCP namespace",
            "key": key,
            "secretExposed": false,
            "isError": true
        }));
    }
    backend
        .compat_delete(&key)
        .await
        .map_err(|e| format!("vault delete failed: {}", e))?;
    Ok(json!({ "ok": true, "key": key, "existed": true, "secretExposed": false }))
}

pub(super) async fn tool_vault_list(args: Value) -> Result<Value, String> {
    let prefix = json_string(Some(&args), "prefix")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let backend = crate::shellx_vault::shared_backend();
    let entries = backend
        .compat_list_agent_visible_keys_with_meta(prefix.as_deref())
        .await?;
    Ok(json!({
        "ok": true,
        "count": entries.len(),
        "entries": entries,
        "secretExposed": false,
        "visibility": "agentVisibleOnly",
        "note": "Values are not returned. User-only Vault entries are hidden from this planning surface."
    }))
}

async fn current_vault_backend_for_mutation(
) -> Result<Arc<crate::shellx_vault::ShellxVaultBackend>, String> {
    let backend = crate::shellx_vault::shared_backend();
    let status = backend.status().await;
    if status.mode == crate::shellx_vault::ShellxVaultMode::Unconfigured {
        return Err(
            "Vault is not configured; create or connect a Vault in ShellX before writing secrets"
                .to_string(),
        );
    }
    if !status.unlocked {
        return Err("Vault is locked; unlock it in ShellX before writing secrets".to_string());
    }
    Ok(backend)
}

pub(super) async fn tool_vault_list_grants(args: Value) -> Result<Value, String> {
    let data = debug_api_get_json("/vault/grants", 10).await?;
    let secret_ref_filter = json_string(Some(&args), "secretRef")
        .or_else(|| json_string(Some(&args), "secret_ref"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let status_filter = json_string(Some(&args), "status")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    let grants = data
        .get("grants")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter(|grant| {
                    vault_grant_matches_filter(
                        grant,
                        secret_ref_filter.as_deref(),
                        status_filter.as_deref(),
                    )
                })
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(json!({
        "ok": true,
        "count": grants.len(),
        "grants": grants,
        "secretExposed": false,
        "note": "Grant metadata only. Pending grants become usable only after ShellX operator approval in the Vault Request Center."
    }))
}

pub(super) fn vault_grant_matches_filter(
    grant: &Value,
    secret_ref_filter: Option<&str>,
    status_filter: Option<&str>,
) -> bool {
    if let Some(secret_ref) = secret_ref_filter {
        if grant.get("secretRef").and_then(|value| value.as_str()) != Some(secret_ref) {
            return false;
        }
    }

    let approved = grant
        .get("approved")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let revoked = grant
        .get("revoked")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    match status_filter {
        Some("pending") => !approved && !revoked,
        Some("approved") => approved,
        Some("active") => approved && !revoked,
        Some("revoked") => revoked,
        Some(_) | None => true,
    }
}

pub(super) async fn tool_vault_request_grant(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let body = vault_grant_request_body(args, caller_session_id)?;
    let data = debug_api_post_json("/vault/grants", &body, 10).await?;
    let grant = data.get("grant").cloned().unwrap_or_else(|| data.clone());
    Ok(json!({
        "ok": true,
        "status": "pendingOperatorApproval",
        "grant": grant,
        "secretExposed": false,
        "note": "Grant request created. The ShellX operator must approve it in the Vault Request Center before any mediated secret use succeeds."
    }))
}

pub(super) async fn tool_vault_agent_request(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let actor_id = vault_agent_actor_id(caller_session_id);
    let action = mcp_arg_string(&args, &["action"])
        .unwrap_or_else(|| "list".to_string())
        .to_ascii_lowercase();
    match action.as_str() {
        "list" | "status" => {
            let data = debug_api_get_json(&format!("/vault/agent-requests?actorId={actor_id}"), 10)
                .await?;
            Ok(json!({
                "ok": true,
                "requests": data.get("requests").cloned().unwrap_or_else(|| json!([])),
                "pendingCount": data.get("pendingCount").cloned().unwrap_or_else(|| json!(0)),
                "resources": data.get("resources").cloned().unwrap_or_else(|| json!([])),
                "secretExposed": false,
                "executionHost": "shellxDesktop",
                "note": "Metadata and redacted command results only. Pending requests require a trusted operator action in the ShellX Vault Request Center."
            }))
        }
        "request" | "submit" => {
            let body = vault_agent_request_body(&args, &actor_id)?;
            let data = debug_api_post_json("/vault/agent-requests", &body, 10).await?;
            Ok(json!({
                "ok": true,
                "status": "pendingOperatorApproval",
                "request": data.get("request").cloned().unwrap_or_else(|| data.clone()),
                "secretExposed": false,
                "executionHost": "shellxDesktop",
                "note": "Request queued. ShellX will run the exact digest-bound executable on the ShellX desktop host only if the operator approves it."
            }))
        }
        "cancel" => {
            let request_id =
                mcp_arg_string(&args, &["requestId", "request_id"]).ok_or_else(|| {
                    "vault_agent_request action=cancel requires requestId".to_string()
                })?;
            let data = debug_api_post_json(
                &format!("/vault/agent-requests/{request_id}/cancel"),
                &json!({ "actorId": actor_id }),
                10,
            )
            .await?;
            Ok(json!({
                "ok": true,
                "request": data.get("request").cloned().unwrap_or_else(|| data.clone()),
                "secretExposed": false
            }))
        }
        other => Err(format!(
            "vault_agent_request unsupported action '{other}'; use request, list, or cancel"
        )),
    }
}

pub(super) fn vault_agent_actor_id(caller_session_id: Option<&str>) -> String {
    crate::shellx_browser_caller::shellx_mcp_agent_identity(caller_session_id)
        .unwrap_or_else(|| "shellx-agent-session:default".to_string())
}

pub(super) fn vault_agent_request_body(args: &Value, actor_id: &str) -> Result<Value, String> {
    let actor_label = mcp_arg_string(args, &["actorLabel", "actor_label"])
        .unwrap_or_else(|| "ShellX agent".to_string());
    let purpose = mcp_arg_string(args, &["purpose", "reason"])
        .ok_or_else(|| "vault_agent_request action=request requires purpose".to_string())?;
    let program = mcp_arg_string(args, &["program", "executable"])
        .ok_or_else(|| "vault_agent_request action=request requires program".to_string())?;
    let command_args = args
        .get("args")
        .map(|value| {
            value
                .as_array()
                .ok_or_else(|| "vault_agent_request args must be an array of strings".to_string())?
                .iter()
                .map(|arg| {
                    arg.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                        "vault_agent_request args must contain only strings".to_string()
                    })
                })
                .collect::<Result<Vec<_>, String>>()
        })
        .transpose()?
        .unwrap_or_default();
    let raw_bindings = args
        .get("bindings")
        .and_then(Value::as_array)
        .ok_or_else(|| "vault_agent_request action=request requires bindings".to_string())?;
    let bindings = raw_bindings
        .iter()
        .map(|binding| {
            let binding = binding.as_object().ok_or_else(|| {
                "vault_agent_request bindings must contain objects".to_string()
            })?;
            let resource_id = binding
                .get("resourceId")
                .or_else(|| binding.get("resource_id"))
                .or_else(|| binding.get("secretRef"))
                .or_else(|| binding.get("secret_ref"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    "vault_agent_request each binding requires resourceId".to_string()
                })?;
            if resource_id.starts_with("pass:") {
                return Err(
                    "vault_agent_request refuses legacy pass-store bindings; use a ShellX Vault resource"
                        .to_string(),
                );
            }
            let resource_id = resource_id.strip_prefix("vault:").unwrap_or(resource_id);
            let env = binding
                .get("env")
                .or_else(|| binding.get("environment"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "vault_agent_request each binding requires env".to_string())?;
            Ok(json!({
                "resourceId": resource_id,
                "field": "value",
                "env": env,
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut spec = serde_json::Map::new();
    spec.insert("purpose".to_string(), Value::String(purpose));
    spec.insert("program".to_string(), Value::String(program));
    spec.insert("args".to_string(), json!(command_args));
    spec.insert("bindings".to_string(), json!(bindings));
    if let Some(cwd) = mcp_arg_string(args, &["cwd", "workingDirectory", "working_directory"]) {
        spec.insert("cwd".to_string(), Value::String(cwd));
    }
    if let Some(timeout_ms) = mcp_arg_u64(args, &["timeoutMs", "timeout_ms"]) {
        spec.insert("timeoutMs".to_string(), json!(timeout_ms));
    }
    Ok(json!({
        "actorId": actor_id,
        "actorLabel": actor_label,
        "spec": Value::Object(spec),
    }))
}

pub(super) fn vault_grant_request_body(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let secret_ref = mcp_arg_string(
        &args,
        &["secretRef", "secret_ref", "resourceRef", "resource_ref"],
    )
    .ok_or_else(|| "vault_request_grant requires secretRef".to_string())?;
    let operation = mcp_arg_string(&args, &["operation", "op"])
        .ok_or_else(|| "vault_request_grant requires operation".to_string())
        .and_then(|value| normalize_vault_grant_operation(&value))?;
    let actor_scope = vault_grant_actor_scope_body(&args, caller_session_id)?;
    let origin =
        mcp_arg_string(&args, &["origin", "browserOrigin", "browser_origin"]).or_else(|| {
            actor_scope
                .get("origin")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    if matches!(
        operation.as_str(),
        "fill" | "profileFill" | "emailCodeRead" | "agentWalletUse"
    ) && origin.is_none()
    {
        return Err(
            "vault_request_grant browser operations require origin=scheme://host[:port]"
                .to_string(),
        );
    }

    let mut body = serde_json::Map::new();
    body.insert("secretRef".to_string(), Value::String(secret_ref));
    body.insert("operation".to_string(), Value::String(operation));
    body.insert("actorScope".to_string(), actor_scope);
    if let Some(origin) = origin {
        body.insert("origin".to_string(), Value::String(origin));
    }
    if let Some(expires_at_ms) = mcp_arg_u64(&args, &["expiresAtMs", "expires_at_ms"]) {
        let expires_at_ms = i64::try_from(expires_at_ms)
            .map_err(|_| "vault_request_grant expiresAtMs is too large".to_string())?;
        body.insert(
            "expiresAtMs".to_string(),
            Value::Number(serde_json::Number::from(expires_at_ms)),
        );
    }
    Ok(Value::Object(body))
}

pub(super) fn normalize_vault_grant_operation(raw: &str) -> Result<String, String> {
    let compact = raw
        .trim()
        .chars()
        .filter(|ch| *ch != '_' && *ch != '-' && !ch.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    match compact.as_str() {
        "fill" => Ok("fill".to_string()),
        "profilefill" => Ok("profileFill".to_string()),
        "emailcoderead" => Ok("emailCodeRead".to_string()),
        "agentwalletuse" => Ok("agentWalletUse".to_string()),
        "injectenv" => Ok("injectEnv".to_string()),
        "provideruse" => Ok("providerUse".to_string()),
        "connectoruse" => Ok("connectorUse".to_string()),
        "deposit" => Ok("deposit".to_string()),
        "rawreveal" => Err(
            "vault_request_grant refuses rawReveal; ask the user to handle plaintext directly"
                .to_string(),
        ),
        other => Err(format!(
            "vault_request_grant unsupported operation '{other}'"
        )),
    }
}

pub(super) fn vault_grant_actor_scope_body(
    args: &Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    if let Some(scope) = args.get("actorScope").or_else(|| args.get("actor_scope")) {
        if let Some(object) = scope.as_object() {
            let is_agent = object
                .get("kind")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("agent"));
            if !is_agent {
                return Ok(scope.clone());
            }
            let agent_id = crate::shellx_browser_caller::shellx_mcp_agent_identity(
                caller_session_id,
            )
            .ok_or_else(|| {
                "vault_request_grant actorKind=agent requires an authenticated Host MCP caller"
                    .to_string()
            })?;
            return Ok(json!({ "kind": "agent", "agentId": agent_id }));
        }
        return Err("vault_request_grant actorScope must be an object".to_string());
    }

    let kind = mcp_arg_string(
        args,
        &["actorKind", "actor_kind", "scopeKind", "scope_kind", "kind"],
    )
    .ok_or_else(|| {
        "vault_request_grant requires an explicit actorScope or actorKind; no grant scope is inferred"
            .to_string()
    })?;
    let compact = kind
        .trim()
        .chars()
        .filter(|ch| *ch != '_' && *ch != '-' && !ch.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();

    match compact.as_str() {
        "allshellxagents" | "allagents" => Ok(json!({ "kind": "allShellxAgents" })),
        "agent" => Ok(json!({
            "kind": "agent",
            "agentId": crate::shellx_browser_caller::shellx_mcp_agent_identity(caller_session_id)
                .ok_or_else(|| "vault_request_grant actorKind=agent requires an authenticated Host MCP caller".to_string())?
        })),
        "provider" => Ok(json!({
            "kind": "provider",
            "providerId": mcp_arg_string(args, &["providerId", "provider_id", "provider"]).ok_or_else(|| "vault_request_grant actorKind=provider requires providerId".to_string())?
        })),
        "workspace" => Ok(json!({
            "kind": "workspace",
            "workspace": mcp_arg_string(args, &["workspace"]).ok_or_else(|| "vault_request_grant actorKind=workspace requires workspace".to_string())?
        })),
        "browserorigin" | "origin" => Ok(json!({
            "kind": "browserOrigin",
            "origin": mcp_arg_string(args, &["origin", "browserOrigin", "browser_origin"]).ok_or_else(|| "vault_request_grant actorKind=browserOrigin requires origin".to_string())?
        })),
        "connector" => Ok(json!({
            "kind": "connector",
            "connectorId": mcp_arg_string(args, &["connectorId", "connector_id", "connector"]).ok_or_else(|| "vault_request_grant actorKind=connector requires connectorId".to_string())?
        })),
        other => Err(format!(
            "vault_request_grant unsupported actorKind '{other}'"
        )),
    }
}

pub(super) async fn tool_vault_generate(args: Value) -> Result<Value, String> {
    let backend = current_vault_backend_for_mutation().await?;
    tool_vault_generate_with_backend(args, backend.as_ref()).await
}

async fn tool_vault_generate_with_backend(
    args: Value,
    backend: &crate::shellx_vault::ShellxVaultBackend,
) -> Result<Value, String> {
    let origin = json_string(Some(&args), "origin")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or("vault_generate: origin is required")?;
    let item_id = json_string(Some(&args), "itemId")
        .or_else(|| json_string(Some(&args), "item_id"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or("vault_generate: itemId is required")?;
    let item_id = normalize_agent_vault_key("vault_generate", &item_id)?;
    let length = args.get("length").and_then(Value::as_u64).unwrap_or(24);
    if !(8..=128).contains(&length) {
        return Err("vault_generate: length must be between 8 and 128".to_string());
    }
    let include_upper = args
        .get("includeUpper")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let include_digits = args
        .get("includeDigits")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let include_symbols = args
        .get("includeSymbols")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let password = zeroize::Zeroizing::new(vault_core::password::generate_password(
        length as usize,
        include_upper,
        include_digits,
        include_symbols,
    ));
    let created = backend
        .compat_create_agent_managed(
            &item_id,
            password.as_str(),
            Some(format!("Generated by ShellX Vault for {origin}")),
        )
        .await?;
    if !created {
        return Ok(json!({
            "ok": false,
            "status": "refused",
            "code": "VAULT_GENERATE_ITEM_EXISTS",
            "message": "vault_generate is create-only and will not overwrite an existing Vault item",
            "itemId": item_id,
            "origin": origin,
            "secretExposed": false,
            "isError": true
        }));
    }
    Ok(json!({
        "ok": true,
        "status": "created",
        "action": "generateAndStore",
        "origin": origin,
        "itemId": item_id,
        "length": length,
        "storageCommitted": true,
        "secretExposed": false
    }))
}

pub(super) async fn tool_vault_deposit(args: Value) -> Result<Value, String> {
    let label = json_string(Some(&args), "label")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or("vault_deposit: label is required")?;
    Ok(json!({
        "ok": true,
        "action": "deposit",
        "label": label,
        "sourceUrl": json_string(Some(&args), "sourceUrl").or_else(|| json_string(Some(&args), "source_url")),
        "taskId": json_string(Some(&args), "taskId").or_else(|| json_string(Some(&args), "task_id")),
        "route": "/browser/vault-deposits",
        "requiredPostFields": ["label", "secretValue"],
        "secretExposed": false
    }))
}

#[cfg(test)]
mod vault_generate_tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn agent_keys_are_namespaced_and_traversal_is_rejected() {
        assert_eq!(
            normalize_agent_vault_key("secret_set", "build/token").unwrap(),
            "agent/build/token"
        );
        assert_eq!(
            normalize_agent_vault_key("secret_set", "vault:agent/build/token").unwrap(),
            "agent/build/token"
        );
        assert!(normalize_agent_vault_key("secret_set", "../operator/token").is_err());
        assert!(normalize_agent_vault_key("secret_set", "agent//token").is_err());
    }

    #[tokio::test]
    async fn agent_managed_metadata_is_durable_and_create_only() {
        let dir = tempfile::tempdir().expect("temp Vault profile");
        let backend = crate::shellx_vault::ShellxVaultBackend::for_test(dir.path().to_path_buf());
        assert!(backend
            .compat_create_agent_managed("agent/test/item", "first", None)
            .await
            .expect("create agent item"));
        assert!(!backend
            .compat_create_agent_managed("agent/test/item", "replacement", None)
            .await
            .expect("refuse replacement"));
        let meta = backend
            .compat_list_keys_with_meta(Some("agent/test/item"))
            .await
            .expect("list metadata")
            .into_iter()
            .find(|item| item.key == "agent/test/item")
            .expect("agent item metadata");
        assert!(agent_vault_metadata_is_mutable(&meta));
        assert_eq!(
            backend
                .compat_get("agent/test/item")
                .await
                .expect("read item"),
            Some("first".to_string())
        );
    }

    #[tokio::test]
    async fn generates_and_stores_once_without_returning_the_secret() {
        let dir = tempfile::tempdir().expect("temp Vault profile");
        let backend = crate::shellx_vault::ShellxVaultBackend::for_test(dir.path().to_path_buf());
        let args = json!({
            "origin": "https://signup.example.test",
            "itemId": "generated/example",
            "length": 32,
            "includeUpper": false,
            "includeDigits": false,
            "includeSymbols": false
        });

        let created = tool_vault_generate_with_backend(args.clone(), &backend)
            .await
            .expect("generate");
        assert_eq!(created["ok"], json!(true));
        assert_eq!(created["status"], json!("created"));
        assert_eq!(created["storageCommitted"], json!(true));
        assert_eq!(created["secretExposed"], json!(false));
        let stored = backend
            .compat_get("agent/generated/example")
            .await
            .expect("read generated item")
            .expect("generated item exists");
        assert_eq!(stored.len(), 32);
        assert!(stored.bytes().all(|byte| byte.is_ascii_lowercase()));
        assert!(!serde_json::to_string(&created).unwrap().contains(&stored));

        let refused = tool_vault_generate_with_backend(args, &backend)
            .await
            .expect("repeat generate");
        assert_eq!(refused["ok"], json!(false));
        assert_eq!(refused["code"], json!("VAULT_GENERATE_ITEM_EXISTS"));
        assert_eq!(
            backend
                .compat_get("agent/generated/example")
                .await
                .expect("read preserved item"),
            Some(stored)
        );
    }

    #[tokio::test]
    async fn concurrent_generation_creates_exactly_one_item() {
        let dir = tempfile::tempdir().expect("temp Vault profile");
        let backend = Arc::new(crate::shellx_vault::ShellxVaultBackend::for_test(
            dir.path().to_path_buf(),
        ));
        let args = json!({
            "origin": "https://race.example.test",
            "itemId": "generated/race",
            "length": 24
        });
        let (left, right) = tokio::join!(
            tool_vault_generate_with_backend(args.clone(), backend.as_ref()),
            tool_vault_generate_with_backend(args, backend.as_ref())
        );
        let results = [left.expect("left generate"), right.expect("right generate")];
        assert_eq!(
            results
                .iter()
                .filter(|result| result["status"] == json!("created"))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| result["code"] == json!("VAULT_GENERATE_ITEM_EXISTS"))
                .count(),
            1
        );
        assert_eq!(
            backend
                .compat_get("agent/generated/race")
                .await
                .expect("read generated item")
                .expect("generated item exists")
                .len(),
            24
        );
    }

    #[tokio::test]
    async fn rejects_out_of_range_length_before_mutation() {
        let dir = tempfile::tempdir().expect("temp Vault profile");
        let backend = crate::shellx_vault::ShellxVaultBackend::for_test(dir.path().to_path_buf());
        let error = tool_vault_generate_with_backend(
            json!({ "origin": "https://example.test", "itemId": "generated/short", "length": 7 }),
            &backend,
        )
        .await
        .expect_err("short length rejected");
        assert!(error.contains("between 8 and 128"));
        assert!(backend
            .compat_get("agent/generated/short")
            .await
            .expect("read missing item")
            .is_none());
    }
}
