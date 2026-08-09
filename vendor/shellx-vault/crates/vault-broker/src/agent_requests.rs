//! Cross-process request queue for mediated agent operations.
//!
//! The queue contains metadata, grants, redacted results, and a non-secret
//! resource catalogue. Secret values never enter this file. The MCP server,
//! CLI, and owner UI serialize changes through a private advisory lock.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::actors::{ActorKind, VaultActor};
use crate::devices::{DeviceKind, DeviceRegistry, VaultDevice};
use crate::grants::{
    GrantAction, GrantConstraints, GrantDecision, GrantPolicy, GrantPolicySnapshot, GrantRequest,
    GrantStatus, GrantUseRequest,
};
use crate::receipts::VaultReceipt;
use crate::resources::{ResourcePermission, VaultResourceKind};

pub const AGENT_STATE_FILE: &str = "agent-state.json";
const AGENT_STATE_LOCK_FILE: &str = "agent-state.lock";
const AGENT_STATE_SCHEMA: &str = "shellx-vault-agent-state-v2";
const MAX_REQUEST_HISTORY: usize = 200;
const MAX_AGENT_STATE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PENDING_REQUESTS: usize = 20;
pub const MAX_PENDING_PER_ACTOR_PER_MINUTE: usize = 5;
pub const DEFAULT_REQUEST_TTL_MS: i64 = 5 * 60 * 1_000;
pub const MAX_COMMAND_TIMEOUT_MS: u64 = 15 * 60 * 1_000;
pub const DEFAULT_COMMAND_TIMEOUT_MS: u64 = 5 * 60 * 1_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentResourceDescriptor {
    pub id: String,
    pub label: String,
    pub kind: VaultResourceKind,
    pub permission: ResourcePermission,
    #[serde(default)]
    pub fields: Vec<String>,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSecretBinding {
    pub resource_id: String,
    pub field: String,
    pub env: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentInjectionSpec {
    pub purpose: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    pub bindings: Vec<AgentSecretBinding>,
    #[serde(default = "default_command_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentRequestStatus {
    Pending,
    Running,
    Denied,
    Cancelled,
    Completed,
    Failed,
    Expired,
}

impl AgentRequestStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Denied | Self::Cancelled | Self::Completed | Self::Failed | Self::Expired
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandResult {
    pub success: bool,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
    pub output_truncated: bool,
    pub timed_out: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentInjectionRequest {
    pub request_id: String,
    pub request_digest: String,
    pub actor_id: String,
    pub actor_label: String,
    pub device_id: String,
    pub spec: AgentInjectionSpec,
    pub grant_ids: Vec<String>,
    pub status: AgentRequestStatus,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    #[serde(default)]
    pub decided_at_ms: Option<i64>,
    #[serde(default)]
    pub completed_at_ms: Option<i64>,
    #[serde(default)]
    pub decision_reason: Option<String>,
    #[serde(default)]
    pub result: Option<AgentCommandResult>,
}

impl AgentInjectionRequest {
    pub fn recompute_digest(&self) -> Result<String> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct DigestPayload<'a> {
            request_id: &'a str,
            actor_id: &'a str,
            device_id: &'a str,
            spec: &'a AgentInjectionSpec,
            grant_ids: &'a [String],
            created_at_ms: i64,
            expires_at_ms: i64,
        }
        let bytes = serde_json::to_vec(&DigestPayload {
            request_id: &self.request_id,
            actor_id: &self.actor_id,
            device_id: &self.device_id,
            spec: &self.spec,
            grant_ids: &self.grant_ids,
            created_at_ms: self.created_at_ms,
            expires_at_ms: self.expires_at_ms,
        })?;
        Ok(blake3::hash(&bytes).to_hex().to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentState {
    #[serde(default = "default_agent_state_schema")]
    pub schema_version: String,
    #[serde(default)]
    pub grant_policy: GrantPolicySnapshot,
    #[serde(default)]
    pub grant_receipts: Vec<VaultReceipt>,
    #[serde(default)]
    pub devices: DeviceRegistry,
    #[serde(default)]
    pub resources: BTreeMap<String, AgentResourceDescriptor>,
    #[serde(default)]
    pub requests: BTreeMap<String, AgentInjectionRequest>,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            schema_version: default_agent_state_schema(),
            grant_policy: GrantPolicySnapshot::default(),
            grant_receipts: Vec::new(),
            devices: DeviceRegistry::default(),
            resources: BTreeMap::new(),
            requests: BTreeMap::new(),
        }
    }
}

impl AgentState {
    pub fn policy(&self) -> GrantPolicy {
        GrantPolicy::from_snapshot_with_receipts(
            self.grant_policy.clone(),
            self.grant_receipts.clone(),
        )
    }

    pub fn store_policy(&mut self, policy: &GrantPolicy) {
        self.grant_policy = policy.to_snapshot();
        self.grant_receipts = policy.receipts().to_vec();
    }

    fn prune_history(&mut self) {
        if self.requests.len() <= MAX_REQUEST_HISTORY {
            return;
        }
        let mut terminal = self
            .requests
            .values()
            .filter(|request| request.status.is_terminal())
            .map(|request| (request.created_at_ms, request.request_id.clone()))
            .collect::<Vec<_>>();
        terminal.sort();
        for (_, request_id) in terminal
            .into_iter()
            .take(self.requests.len().saturating_sub(MAX_REQUEST_HISTORY))
        {
            self.requests.remove(&request_id);
        }
    }
}

pub struct AgentStateStore {
    profile_dir: PathBuf,
}

impl AgentStateStore {
    pub fn current() -> Result<Self> {
        Ok(Self {
            profile_dir: crate::profile::ensure_current_profile_dir()?,
        })
    }

    pub fn for_profile_dir(profile_dir: impl Into<PathBuf>) -> Result<Self> {
        let profile_dir = profile_dir.into();
        std::fs::create_dir_all(&profile_dir)?;
        Ok(Self { profile_dir })
    }

    pub fn profile_dir(&self) -> &Path {
        &self.profile_dir
    }

    pub fn lock(&self) -> Result<AgentStateGuard> {
        reject_symlink(&self.profile_dir.join(AGENT_STATE_LOCK_FILE))?;
        let lock = open_private_lock(&self.profile_dir.join(AGENT_STATE_LOCK_FILE))?;
        lock.lock_exclusive().context("lock Vault agent state")?;
        let path = self.profile_dir.join(AGENT_STATE_FILE);
        reject_symlink(&path)?;
        Ok(AgentStateGuard { lock, path })
    }

    pub fn load(&self) -> Result<AgentState> {
        self.lock()?.load()
    }

    pub fn snapshot(&self, now_ms: i64) -> Result<AgentState> {
        let guard = self.lock()?;
        let mut state = guard.load()?;
        if expire_pending_in_state(&mut state, now_ms) {
            guard.save(&mut state)?;
        }
        Ok(state)
    }

    pub fn sync_resources(&self, resources: Vec<AgentResourceDescriptor>) -> Result<()> {
        let guard = self.lock()?;
        let mut state = guard.load()?;
        state.resources = resources
            .into_iter()
            .map(|resource| (resource.id.clone(), resource))
            .collect();
        let mut policy = state.policy();
        let mut snapshot = policy.to_snapshot();
        snapshot.resource_permissions = state
            .resources
            .iter()
            .map(|(id, resource)| (id.clone(), resource.permission.clone()))
            .collect();
        policy = GrantPolicy::from_snapshot_with_receipts(snapshot, policy.receipts().to_vec());
        state.store_policy(&policy);
        guard.save(&mut state)
    }

    pub fn submit_injection_request(
        &self,
        actor_id: String,
        actor_label: String,
        device_id: String,
        spec: AgentInjectionSpec,
        now_ms: i64,
    ) -> Result<AgentInjectionRequest> {
        validate_actor_text(&actor_id, "actor id")?;
        validate_actor_text(&device_id, "device id")?;
        let actor_label = sanitize_untrusted_display_text(&actor_label);
        validate_actor_text(&actor_label, "actor label")?;
        let mut spec = spec;
        spec.purpose = sanitize_untrusted_display_text(&spec.purpose);
        validate_injection_spec(&spec)?;

        let guard = self.lock()?;
        let mut state = guard.load()?;
        let _ = expire_pending_in_state(&mut state, now_ms);
        let pending = state
            .requests
            .values()
            .filter(|request| request.status == AgentRequestStatus::Pending)
            .collect::<Vec<_>>();
        if pending.len() >= MAX_PENDING_REQUESTS {
            bail!("Vault approval queue is full; review or deny pending requests first");
        }
        let recent_from_actor = pending
            .iter()
            .filter(|request| {
                request.actor_id == actor_id
                    && request.created_at_ms >= now_ms.saturating_sub(60_000)
            })
            .count();
        if recent_from_actor >= MAX_PENDING_PER_ACTOR_PER_MINUTE {
            bail!("Vault temporarily refused this actor after too many pending requests");
        }
        if let Some(device) = state.devices.get(&device_id) {
            if device.revoked_at_ms.is_some() {
                bail!("requesting device is revoked");
            }
        } else {
            state.devices.register(VaultDevice {
                device_id: device_id.clone(),
                label: device_id.clone(),
                kind: current_device_kind(),
                created_at_ms: now_ms,
                revoked_at_ms: None,
            });
        }

        let mut policy = state.policy();
        if let Some(actor) = policy.to_snapshot().actors.get(&actor_id) {
            if actor.revoked_at_ms.is_some() {
                bail!("requesting actor is revoked");
            }
        } else {
            policy.register_actor(VaultActor {
                actor_id: actor_id.clone(),
                kind: ActorKind::McpAgent,
                display_name: actor_label.clone(),
                device_id: device_id.clone(),
                public_key: None,
                created_at_ms: now_ms,
                revoked_at_ms: None,
            });
        }

        let mut grant_ids = Vec::new();
        for binding in &spec.bindings {
            let resource = state
                .resources
                .get(&binding.resource_id)
                .ok_or_else(|| anyhow!("Vault resource not found: {}", binding.resource_id))?;
            if resource.permission == ResourcePermission::UserOnly {
                bail!("Vault resource is user-only: {}", resource.label);
            }
            if !resource.fields.iter().any(|field| field == &binding.field) {
                bail!(
                    "secret field {} is not available on {}",
                    binding.field,
                    resource.label
                );
            }
            policy.set_resource_permission(&binding.resource_id, resource.permission.clone());
            let grant = policy
                .create_grant(GrantRequest {
                    actor_id: actor_id.clone(),
                    resource_id: binding.resource_id.clone(),
                    action: GrantAction::InjectEnv,
                    constraints: GrantConstraints {
                        expires_at_ms: Some(now_ms.saturating_add(DEFAULT_REQUEST_TTL_MS)),
                        max_uses: Some(1),
                        machine_id: Some(device_id.clone()),
                        ..GrantConstraints::default()
                    },
                    created_at_ms: now_ms,
                })
                .map_err(|reason| anyhow!("grant request denied: {reason:?}"))?;
            grant_ids.push(grant.grant_id);
        }

        let request_id = format!(
            "request-{}-{}",
            now_ms,
            hex::encode(vault_core::random_bytes::<8>())
        );
        let mut request = AgentInjectionRequest {
            request_id: request_id.clone(),
            request_digest: String::new(),
            actor_id,
            actor_label,
            device_id,
            spec,
            grant_ids,
            status: AgentRequestStatus::Pending,
            created_at_ms: now_ms,
            expires_at_ms: now_ms.saturating_add(DEFAULT_REQUEST_TTL_MS),
            decided_at_ms: None,
            completed_at_ms: None,
            decision_reason: None,
            result: None,
        };
        request.request_digest = request.recompute_digest()?;
        state.requests.insert(request_id, request.clone());
        state.store_policy(&policy);
        guard.save(&mut state)?;
        Ok(request)
    }

    pub fn begin_approved_request(
        &self,
        request_id: &str,
        expected_digest: &str,
        now_ms: i64,
    ) -> Result<AgentInjectionRequest> {
        let guard = self.lock()?;
        let mut state = guard.load()?;
        let expired = expire_pending_in_state(&mut state, now_ms);
        let request = state
            .requests
            .get(request_id)
            .cloned()
            .ok_or_else(|| anyhow!("agent request not found"))?;
        if let Err(error) = require_pending_unchanged(&request, expected_digest, now_ms) {
            if expired {
                guard.save(&mut state)?;
            }
            return Err(error);
        }

        let mut policy = state.policy();
        for (binding, grant_id) in request.spec.bindings.iter().zip(&request.grant_ids) {
            let grant = policy
                .grant(grant_id)
                .ok_or_else(|| anyhow!("request grant not found"))?;
            if grant.status != GrantStatus::Pending {
                bail!("request grant is no longer pending");
            }
            policy
                .approve_grant(grant_id, now_ms)
                .map_err(|reason| anyhow!("grant approval denied: {reason:?}"))?;
            match policy.authorize(GrantUseRequest {
                grant_id: grant_id.clone(),
                actor_id: request.actor_id.clone(),
                resource_id: binding.resource_id.clone(),
                action: GrantAction::InjectEnv,
                origin: None,
                path: None,
                now_ms,
            }) {
                GrantDecision::AllowMediated { .. } => {}
                GrantDecision::Deny { reason, .. } => {
                    state.store_policy(&policy);
                    guard.save(&mut state)?;
                    bail!("request authorization denied: {reason:?}");
                }
            }
        }

        let current = state
            .requests
            .get_mut(request_id)
            .ok_or_else(|| anyhow!("agent request disappeared"))?;
        current.status = AgentRequestStatus::Running;
        current.decided_at_ms = Some(now_ms);
        let approved = current.clone();
        state.store_policy(&policy);
        guard.save(&mut state)?;
        Ok(approved)
    }

    pub fn deny_request(
        &self,
        request_id: &str,
        expected_digest: &str,
        reason: &str,
        now_ms: i64,
    ) -> Result<AgentInjectionRequest> {
        let _ = self.snapshot(now_ms)?;
        self.finish_without_execution(
            request_id,
            Some(expected_digest),
            AgentRequestStatus::Denied,
            reason,
            now_ms,
            None,
        )
    }

    pub fn cancel_request(
        &self,
        request_id: &str,
        actor_id: &str,
        now_ms: i64,
    ) -> Result<AgentInjectionRequest> {
        let guard = self.lock()?;
        let state = guard.load()?;
        let current = state
            .requests
            .get(request_id)
            .cloned()
            .ok_or_else(|| anyhow!("agent request not found"))?;
        if current.actor_id != actor_id {
            bail!("request belongs to a different actor");
        }
        if current.status != AgentRequestStatus::Pending {
            bail!("only pending requests can be cancelled");
        }
        drop(state);
        drop(guard);
        self.finish_without_execution(
            request_id,
            None,
            AgentRequestStatus::Cancelled,
            "cancelled by requesting agent",
            now_ms,
            None,
        )
    }

    pub fn finish_request(
        &self,
        request_id: &str,
        result: AgentCommandResult,
        now_ms: i64,
    ) -> Result<AgentInjectionRequest> {
        let status = if result.success {
            AgentRequestStatus::Completed
        } else {
            AgentRequestStatus::Failed
        };
        self.finish_without_execution(
            request_id,
            None,
            status,
            if result.timed_out {
                "approved command timed out"
            } else if result.success {
                "approved command completed"
            } else {
                "approved command failed"
            },
            now_ms,
            Some(result),
        )
    }

    fn finish_without_execution(
        &self,
        request_id: &str,
        expected_digest: Option<&str>,
        status: AgentRequestStatus,
        reason: &str,
        now_ms: i64,
        result: Option<AgentCommandResult>,
    ) -> Result<AgentInjectionRequest> {
        let guard = self.lock()?;
        let mut state = guard.load()?;
        let current = state
            .requests
            .get(request_id)
            .cloned()
            .ok_or_else(|| anyhow!("agent request not found"))?;
        if let Some(expected_digest) = expected_digest {
            require_pending_unchanged(&current, expected_digest, now_ms)?;
        } else if result.is_some() && current.status != AgentRequestStatus::Running {
            bail!("agent request is not running");
        } else if result.is_none() && current.status != AgentRequestStatus::Pending {
            bail!("agent request is no longer pending");
        }

        let mut policy = state.policy();
        if result.is_none() {
            for grant_id in &current.grant_ids {
                if policy
                    .grant(grant_id)
                    .is_some_and(|grant| grant.status == GrantStatus::Pending)
                {
                    let _ = policy.revoke_grant(grant_id, now_ms);
                }
            }
        }

        let request = state
            .requests
            .get_mut(request_id)
            .ok_or_else(|| anyhow!("agent request disappeared"))?;
        request.status = status;
        request.decided_at_ms.get_or_insert(now_ms);
        request.completed_at_ms = Some(now_ms);
        request.decision_reason = Some(reason.to_string());
        request.result = result;
        let finished = request.clone();
        state.store_policy(&policy);
        guard.save(&mut state)?;
        Ok(finished)
    }
}

pub struct AgentStateGuard {
    lock: File,
    path: PathBuf,
}

impl AgentStateGuard {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<AgentState> {
        match vault_client::config::read_string_limited(&self.path, MAX_AGENT_STATE_BYTES) {
            Ok(raw) => {
                let state: AgentState = serde_json::from_str(&raw)
                    .with_context(|| format!("parse broker state {}", self.path.display()))?;
                if state.schema_version != AGENT_STATE_SCHEMA
                    && state.schema_version != default_agent_state_schema()
                {
                    bail!("unsupported Vault agent state schema");
                }
                for request in state.requests.values() {
                    if request.recompute_digest()? != request.request_digest {
                        bail!(
                            "Vault agent request digest mismatch: {}",
                            request.request_id
                        );
                    }
                }
                Ok(state)
            }
            Err(error) if vault_client::config::is_not_found(&error) => Ok(AgentState::default()),
            Err(error) => {
                Err(error).with_context(|| format!("read broker state {}", self.path.display()))
            }
        }
    }

    pub fn save(&self, state: &mut AgentState) -> Result<()> {
        state.schema_version = AGENT_STATE_SCHEMA.to_string();
        state.prune_history();
        let raw = serde_json::to_vec_pretty(state)?;
        vault_client::config::write_private(&self.path, &raw)
    }
}

impl Drop for AgentStateGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.lock);
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64
}

pub fn validate_injection_spec(spec: &AgentInjectionSpec) -> Result<()> {
    let purpose = spec.purpose.trim();
    if purpose.is_empty() || purpose.chars().count() > 500 {
        bail!("purpose must contain 1 to 500 characters");
    }
    if spec.program.len() > 4_096
        || spec.program.contains('\0')
        || spec.program.chars().any(is_ambiguous_display_control)
    {
        bail!("program path is invalid");
    }
    if !Path::new(&spec.program).is_absolute() {
        bail!("program must be an absolute path; shell commands are not accepted");
    }
    reject_inline_interpreter_evaluation(&spec.program, &spec.args)?;
    if let Some(cwd) = spec.cwd.as_deref() {
        if cwd.len() > 4_096
            || cwd.contains('\0')
            || cwd.chars().any(is_ambiguous_display_control)
            || !Path::new(cwd).is_absolute()
        {
            bail!("working directory must be an absolute path");
        }
    }
    if spec.args.len() > 64
        || spec.args.iter().any(|arg| {
            arg.len() > 16_384
                || arg.contains('\0')
                || arg.chars().any(is_ambiguous_display_control)
        })
    {
        bail!("command arguments exceed the safe request limits");
    }
    if spec.bindings.is_empty() || spec.bindings.len() > 16 {
        bail!("a request must contain between 1 and 16 secret bindings");
    }
    if spec.timeout_ms == 0 || spec.timeout_ms > MAX_COMMAND_TIMEOUT_MS {
        bail!("command timeout must be between 1 ms and 15 minutes");
    }
    let mut env_names = BTreeSet::new();
    for binding in &spec.bindings {
        validate_actor_text(&binding.resource_id, "resource id")?;
        validate_actor_text(&binding.field, "secret field")?;
        validate_env_name(&binding.env)?;
        if !env_names.insert(binding.env.to_ascii_uppercase()) {
            bail!("duplicate environment binding: {}", binding.env);
        }
    }
    Ok(())
}

fn require_pending_unchanged(
    request: &AgentInjectionRequest,
    expected_digest: &str,
    now_ms: i64,
) -> Result<()> {
    if request.status != AgentRequestStatus::Pending {
        bail!("agent request is no longer pending");
    }
    if request.request_digest != expected_digest
        || request.recompute_digest()? != request.request_digest
    {
        bail!("agent request changed after it was displayed; approval refused");
    }
    if request.expires_at_ms <= now_ms {
        bail!("agent request expired");
    }
    Ok(())
}

fn validate_actor_text(value: &str, label: &str) -> Result<()> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 512
        || trimmed.contains(['\0', '\n', '\r'])
        || trimmed.chars().any(is_ambiguous_display_control)
    {
        bail!("{label} is invalid");
    }
    Ok(())
}

fn validate_env_name(name: &str) -> Result<()> {
    let mut chars = name.chars();
    let valid_start = chars
        .next()
        .is_some_and(|ch| ch == '_' || ch.is_ascii_alphabetic());
    if !valid_start || name.len() > 128 || !chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
    {
        bail!("invalid environment variable name: {name}");
    }
    let upper = name.to_ascii_uppercase();
    const DENIED_EXACT: &[&str] = &[
        "PATH",
        "PATHEXT",
        "COMSPEC",
        "SYSTEMROOT",
        "WINDIR",
        "HOME",
        "USERPROFILE",
        "NODE_OPTIONS",
        "PYTHONPATH",
        "PYTHONHOME",
        "BASH_ENV",
        "ENV",
        "RUSTC_WRAPPER",
        "GIT_SSH_COMMAND",
        "GIT_CONFIG_GLOBAL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ];
    const DENIED_PREFIXES: &[&str] = &["LD_", "DYLD_", "MALLOC_", "ASAN_", "TSAN_"];
    if DENIED_EXACT.contains(&upper.as_str())
        || DENIED_PREFIXES
            .iter()
            .any(|prefix| upper.starts_with(prefix))
    {
        bail!("environment variable {name} can alter program loading and is not allowed");
    }
    Ok(())
}

fn current_device_kind() -> DeviceKind {
    match std::env::consts::OS {
        "windows" => DeviceKind::Windows,
        "macos" => DeviceKind::Macos,
        "linux" => DeviceKind::Linux,
        _ => DeviceKind::Unknown,
    }
}

fn default_agent_state_schema() -> String {
    AGENT_STATE_SCHEMA.to_string()
}

fn default_command_timeout_ms() -> u64 {
    DEFAULT_COMMAND_TIMEOUT_MS
}

pub fn sanitize_untrusted_display_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| !is_ambiguous_display_control(*character))
        .collect::<String>()
}

fn is_ambiguous_display_control(character: char) -> bool {
    matches!(
        character,
        '\u{061c}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2069}'
            | '\u{feff}'
    )
}

fn reject_inline_interpreter_evaluation(program: &str, args: &[String]) -> Result<()> {
    let resolved_program = std::fs::canonicalize(program)
        .ok()
        .unwrap_or_else(|| Path::new(program).to_path_buf());
    let executable = resolved_program
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let executable = executable.strip_suffix(".exe").unwrap_or(&executable);
    let denied = match executable {
        "sh" | "bash" | "zsh" | "fish" | "dash" | "ash" | "ksh" => {
            args.iter().any(|arg| arg == "-c")
        }
        "cmd" => args.iter().any(|arg| arg.eq_ignore_ascii_case("/c")),
        "powershell" | "pwsh" => args.iter().any(|arg| {
            matches!(
                arg.to_ascii_lowercase().as_str(),
                "-command" | "-c" | "-encodedcommand" | "-enc"
            )
        }),
        "python" | "python3" | "node" | "ruby" | "perl" | "bun" => args.iter().any(|arg| {
            matches!(
                arg.to_ascii_lowercase().as_str(),
                "-c" | "-e" | "--eval" | "--print"
            )
        }),
        "deno" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "eval" | "-e" | "--eval")),
        "php" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "-r" | "--run")),
        "r" | "rscript" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "-e" | "--expr")),
        "osascript" => args.iter().any(|arg| arg == "-e"),
        "script" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "-c" | "--command")),
        "env" | "busybox" | "timeout" | "nohup" | "nice" | "setsid" | "stdbuf" | "xargs"
        | "find" | "wsl" => {
            args.iter()
                .any(|arg| matches!(arg.as_str(), "-S" | "--split-string"))
                || args.iter().enumerate().any(|(index, nested_program)| {
                    reject_inline_interpreter_evaluation(nested_program, &args[index + 1..])
                        .is_err()
                })
        }
        _ => false,
    };
    if denied {
        bail!("inline shell or interpreter evaluation is not allowed; request a direct executable or explicit script file instead");
    }
    Ok(())
}

fn expire_pending_in_state(state: &mut AgentState, now_ms: i64) -> bool {
    let expired = state
        .requests
        .values()
        .filter(|request| {
            request.status == AgentRequestStatus::Pending && request.expires_at_ms <= now_ms
        })
        .map(|request| request.request_id.clone())
        .collect::<Vec<_>>();
    if expired.is_empty() {
        return false;
    }
    let mut policy = state.policy();
    for request_id in expired {
        let Some(request) = state.requests.get_mut(&request_id) else {
            continue;
        };
        for grant_id in &request.grant_ids {
            if policy
                .grant(grant_id)
                .is_some_and(|grant| grant.status == GrantStatus::Pending)
            {
                let _ = policy.revoke_grant(grant_id, now_ms);
            }
        }
        request.status = AgentRequestStatus::Expired;
        request.decided_at_ms = Some(now_ms);
        request.completed_at_ms = Some(now_ms);
        request.decision_reason = Some("request expired before owner approval".to_string());
    }
    state.store_policy(&policy);
    true
}

fn reject_symlink(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!(
                "Vault agent state path must not be a symlink: {}",
                path.display()
            )
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(unix)]
fn open_private_lock(path: &Path) -> Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    Ok(OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)?)
}

#[cfg(not(unix))]
fn open_private_lock(path: &Path) -> Result<File> {
    Ok(OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(permission: ResourcePermission) -> AgentResourceDescriptor {
        AgentResourceDescriptor {
            id: "login/example".to_string(),
            label: "Example login".to_string(),
            kind: VaultResourceKind::Login,
            permission,
            fields: vec!["password".to_string()],
            updated_at_ms: 1,
        }
    }

    fn spec() -> AgentInjectionSpec {
        AgentInjectionSpec {
            purpose: "Authenticate the approved test command".to_string(),
            program: if cfg!(windows) {
                r"C:\Windows\System32\cmd.exe".to_string()
            } else {
                "/usr/bin/printf".to_string()
            },
            args: vec!["ok".to_string()],
            cwd: None,
            bindings: vec![AgentSecretBinding {
                resource_id: "login/example".to_string(),
                field: "password".to_string(),
                env: "EXAMPLE_PASSWORD".to_string(),
            }],
            timeout_ms: 1_000,
        }
    }

    #[test]
    fn request_digest_rejects_tampering_and_raw_values_are_absent() {
        let temp = tempfile::tempdir().unwrap();
        let store = AgentStateStore::for_profile_dir(temp.path()).unwrap();
        store
            .sync_resources(vec![descriptor(ResourcePermission::VisibleAsk)])
            .unwrap();
        let request = store
            .submit_injection_request(
                "mcp:test".to_string(),
                "Test agent".to_string(),
                "test-device".to_string(),
                spec(),
                10,
            )
            .unwrap();
        let raw = std::fs::read_to_string(temp.path().join(AGENT_STATE_FILE)).unwrap();
        assert!(!raw.contains("secretValue"));
        assert!(!raw.contains("password-value"));

        let guard = store.lock().unwrap();
        let mut state = guard.load().unwrap();
        state
            .requests
            .get_mut(&request.request_id)
            .unwrap()
            .spec
            .program = "/tmp/changed".to_string();
        let raw = serde_json::to_vec_pretty(&state).unwrap();
        vault_client::config::write_private(guard.path(), &raw).unwrap();
        drop(guard);
        assert!(store
            .load()
            .unwrap_err()
            .to_string()
            .contains("digest mismatch"));
    }

    #[test]
    fn user_only_resources_and_loader_environment_variables_are_denied() {
        let temp = tempfile::tempdir().unwrap();
        let store = AgentStateStore::for_profile_dir(temp.path()).unwrap();
        store
            .sync_resources(vec![descriptor(ResourcePermission::UserOnly)])
            .unwrap();
        assert!(store
            .submit_injection_request(
                "mcp:test".to_string(),
                "Test agent".to_string(),
                "test-device".to_string(),
                spec(),
                10,
            )
            .unwrap_err()
            .to_string()
            .contains("user-only"));

        let mut invalid = spec();
        invalid.bindings[0].env = "LD_PRELOAD".to_string();
        assert!(validate_injection_spec(&invalid).is_err());
    }

    #[test]
    fn approval_is_one_time_and_digest_bound() {
        let temp = tempfile::tempdir().unwrap();
        let store = AgentStateStore::for_profile_dir(temp.path()).unwrap();
        store
            .sync_resources(vec![descriptor(ResourcePermission::AlwaysAllowed)])
            .unwrap();
        let request = store
            .submit_injection_request(
                "mcp:test".to_string(),
                "Test agent".to_string(),
                "test-device".to_string(),
                spec(),
                10,
            )
            .unwrap();
        let running = store
            .begin_approved_request(&request.request_id, &request.request_digest, 11)
            .unwrap();
        assert_eq!(running.status, AgentRequestStatus::Running);
        assert!(store
            .begin_approved_request(&request.request_id, &request.request_digest, 12)
            .is_err());
    }

    #[test]
    fn inline_interpreter_evaluation_is_denied_but_script_files_are_allowed() {
        let mut inline = spec();
        inline.program = if cfg!(windows) {
            r"C:\Windows\System32\cmd.exe".to_string()
        } else {
            "/bin/bash".to_string()
        };
        inline.args = if cfg!(windows) {
            vec!["/c".to_string(), "echo unsafe".to_string()]
        } else {
            vec!["-c".to_string(), "echo unsafe".to_string()]
        };
        assert!(validate_injection_spec(&inline)
            .unwrap_err()
            .to_string()
            .contains("inline shell"));

        inline.args = if cfg!(windows) {
            vec![r"C:\Users\owner\script.cmd".to_string()]
        } else {
            vec!["/home/owner/script.sh".to_string()]
        };
        assert!(validate_injection_spec(&inline).is_ok());

        for (program, args) in [
            ("/bin/dash", vec!["-c", "echo unsafe"]),
            ("/usr/bin/env", vec!["bash", "-c", "echo unsafe"]),
            ("/bin/busybox", vec!["sh", "-c", "echo unsafe"]),
            ("/usr/bin/deno", vec!["eval", "console.log('unsafe')"]),
            ("/usr/bin/php", vec!["-r", "echo 'unsafe';"]),
            ("/usr/bin/Rscript", vec!["-e", "print('unsafe')"]),
            ("/usr/bin/env", vec!["python", "-c", "print('unsafe')"]),
            ("/usr/bin/timeout", vec!["5", "sh", "-c", "echo unsafe"]),
            (
                "/usr/bin/nohup",
                vec!["node", "-e", "console.log('unsafe')"],
            ),
            (
                "/usr/bin/find",
                vec![".", "-exec", "sh", "-c", "echo unsafe", ";"],
            ),
            ("/usr/bin/xargs", vec!["sh", "-c", "echo unsafe"]),
            ("/usr/bin/osascript", vec!["-e", "do shell script \"id\""]),
        ] {
            inline.program = program.to_string();
            inline.args = args.into_iter().map(str::to_string).collect();
            assert!(validate_injection_spec(&inline)
                .unwrap_err()
                .to_string()
                .contains("inline shell"));
        }
    }

    #[test]
    fn untrusted_display_controls_are_removed_and_identifiers_reject_them() {
        assert_eq!(
            sanitize_untrusted_display_text("safe\u{202e}txt\u{200b}"),
            "safetxt"
        );
        assert!(validate_actor_text("mcp:\u{202e}spoof", "actor id").is_err());
        let mut spoofed = spec();
        spoofed.args.push("safe\u{202e}txt".to_string());
        assert!(validate_injection_spec(&spoofed).is_err());
    }

    #[test]
    fn prompt_fatigue_limit_refuses_the_sixth_pending_request() {
        let temp = tempfile::tempdir().unwrap();
        let store = AgentStateStore::for_profile_dir(temp.path()).unwrap();
        store
            .sync_resources(vec![descriptor(ResourcePermission::VisibleAsk)])
            .unwrap();
        for offset in 0..MAX_PENDING_PER_ACTOR_PER_MINUTE {
            store
                .submit_injection_request(
                    "mcp:test".to_string(),
                    "Test agent".to_string(),
                    "test-device".to_string(),
                    spec(),
                    10_000 + offset as i64,
                )
                .unwrap();
        }
        assert!(store
            .submit_injection_request(
                "mcp:test".to_string(),
                "Test agent".to_string(),
                "test-device".to_string(),
                spec(),
                10_100,
            )
            .unwrap_err()
            .to_string()
            .contains("too many pending"));
    }

    #[test]
    fn snapshot_expires_pending_requests_and_revokes_their_grants() {
        let temp = tempfile::tempdir().unwrap();
        let store = AgentStateStore::for_profile_dir(temp.path()).unwrap();
        store
            .sync_resources(vec![descriptor(ResourcePermission::VisibleAsk)])
            .unwrap();
        let request = store
            .submit_injection_request(
                "mcp:test".to_string(),
                "Test agent".to_string(),
                "test-device".to_string(),
                spec(),
                10,
            )
            .unwrap();
        let state = store.snapshot(10 + DEFAULT_REQUEST_TTL_MS).unwrap();
        assert_eq!(
            state.requests[&request.request_id].status,
            AgentRequestStatus::Expired
        );
        assert!(request.grant_ids.iter().all(|grant_id| {
            state.grant_policy.grants[grant_id].status == GrantStatus::Revoked
        }));
    }
}
