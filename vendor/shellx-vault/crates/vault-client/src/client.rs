//! Typed HTTP client for the vault-server API. Thin: every method maps
//! 1:1 to a server route; no sync logic lives here.
//!
//! `reqwest::Client` is internally reference-counted — `Api` is Clone and
//! cheap to hand to concurrent upload/download futures.

use anyhow::{bail, Context, Result};
use serde::Deserialize;

/// CAS header (must match the server's `api::PARENT_GEN_HEADER`).
const PARENT_GEN_HEADER: &str = "x-sxvault-parent-gen";

#[derive(Clone)]
pub struct Api {
    http: reqwest::Client,
    /// Server root, e.g. "https://box.example.com" — only /v1/ping lives here.
    base_url: String,
    /// Repo-scoped data prefix: "<base>/v1/repos/<repo>".
    data_url: String,
    token: String,
}

#[derive(Debug, Deserialize)]
pub struct RemoteHead {
    pub generation: u64,
    pub id: String,
    /// Chain anchor: history below this generation was pruned. Older
    /// servers omit it → 1 (nothing pruned).
    #[serde(default = "default_first_gen")]
    pub first_generation: u64,
}

fn default_first_gen() -> u64 {
    1
}

#[derive(Debug, Deserialize)]
pub struct PruneOutcome {
    pub trashed_manifests: u64,
    pub trashed_blobs: u64,
    pub trashed_bytes: u64,
    pub first_generation: u64,
}

/// Server receipt for a stored deposit: `payload_hash` is the server-
/// computed blake3 of the sealed bytes, so the receipt provably binds to
/// what was stored (this is the artifact an agent records in its trace).
#[derive(Debug, Deserialize, serde::Serialize)]
pub struct DepositReceipt {
    pub id: String,
    pub payload_hash: String,
    pub created_ms: i64,
}

/// One pending write-only deposit as the server stores it (sealed —
/// only the owner's derived deposit secret opens `sealed_hex`).
#[derive(Debug, Deserialize)]
pub struct DepositRecord {
    pub id: String,
    pub created_ms: i64,
    pub from_token: String,
    pub payload_hash: String,
    pub sealed_hex: String,
}

/// Outcome of a manifest commit attempt.
pub enum CommitResult {
    Committed(RemoteHead),
    /// CAS miss — someone else committed first; the caller refetches.
    Conflict,
}

impl Api {
    pub fn new(server_url: &str, repo: &str, token: &str) -> Result<Self> {
        let base_url = server_url.trim_end_matches('/').to_string();
        if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
            bail!("server URL must start with http:// or https://");
        }
        if repo.is_empty()
            || !repo
                .bytes()
                .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
        {
            bail!("repo name must be [a-z0-9-]");
        }
        Ok(Api {
            http: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .build()?,
            data_url: format!("{base_url}/v1/repos/{repo}"),
            base_url,
            token: token.to_string(),
        })
    }

    fn auth(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        rb.header("authorization", format!("Bearer {}", self.token))
    }

    pub async fn ping(&self) -> Result<()> {
        let resp = self
            .auth(self.http.get(format!("{}/v1/ping", self.base_url)))
            .send()
            .await?;
        match resp.status().as_u16() {
            200 => Ok(()),
            401 => bail!("server rejected the token (401)"),
            s => bail!("unexpected ping status {s}"),
        }
    }

    /// Current head, or None for an empty repository.
    pub async fn head(&self) -> Result<Option<RemoteHead>> {
        let resp = self
            .auth(self.http.get(format!("{}/manifests/head", self.data_url)))
            .send()
            .await?;
        match resp.status().as_u16() {
            200 => Ok(Some(resp.json().await?)),
            404 => Ok(None),
            401 => bail!("server rejected the token (401)"),
            s => bail!("unexpected head status {s}"),
        }
    }

    pub async fn get_manifest(&self, generation: u64) -> Result<Vec<u8>> {
        let resp = self
            .auth(
                self.http
                    .get(format!("{}/manifests/{generation}", self.data_url)),
            )
            .send()
            .await?;
        if !resp.status().is_success() {
            bail!("manifest {generation} fetch failed: {}", resp.status());
        }
        Ok(resp.bytes().await?.to_vec())
    }

    pub async fn commit_manifest(&self, parent_gen: u64, sealed: Vec<u8>) -> Result<CommitResult> {
        let resp = self
            .auth(self.http.post(format!("{}/manifests", self.data_url)))
            .header(PARENT_GEN_HEADER, parent_gen.to_string())
            .body(sealed)
            .send()
            .await?;
        match resp.status().as_u16() {
            201 => Ok(CommitResult::Committed(resp.json().await?)),
            409 => Ok(CommitResult::Conflict),
            s => bail!("manifest commit failed: status {s}"),
        }
    }

    /// Which of `ids` (hex) the server does NOT have yet.
    pub async fn missing_blobs(&self, ids: &[String]) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct CheckResponse {
            missing: Vec<String>,
        }
        let mut missing = Vec::new();
        // Server caps a check request at 10k ids; stay well under it.
        for batch in ids.chunks(1000) {
            let resp = self
                .auth(self.http.post(format!("{}/blobs/check", self.data_url)))
                .json(&serde_json::json!({ "ids": batch }))
                .send()
                .await?;
            if !resp.status().is_success() {
                bail!("blob check failed: {}", resp.status());
            }
            let r: CheckResponse = resp.json().await?;
            missing.extend(r.missing);
        }
        Ok(missing)
    }

    pub async fn put_blob(&self, id_hex: &str, sealed: Vec<u8>) -> Result<()> {
        let resp = self
            .auth(self.http.put(format!("{}/blobs/{id_hex}", self.data_url)))
            .body(sealed)
            .send()
            .await?;
        if !resp.status().is_success() {
            bail!("blob upload {id_hex} failed: {}", resp.status());
        }
        Ok(())
    }

    /// Server-side GC: truncate history below `keep_from_gen`, trash the
    /// listed blobs. Caller must have computed liveness (see engine::prune).
    pub async fn prune(&self, keep_from_gen: u64, delete_blobs: &[String]) -> Result<PruneOutcome> {
        let resp = self
            .auth(self.http.post(format!("{}/prune", self.data_url)))
            .json(&serde_json::json!({
                "keep_from_gen": keep_from_gen,
                "delete_blobs": delete_blobs,
            }))
            .send()
            .await?;
        if !resp.status().is_success() {
            bail!(
                "prune failed: {} — {}",
                resp.status(),
                resp.text().await.unwrap_or_default()
            );
        }
        Ok(resp.json().await?)
    }

    /// Publish the passphrase-wrapped keyfile for web access (opt-in).
    pub async fn put_keyfile(&self, keyfile_json: Vec<u8>) -> Result<()> {
        let resp = self
            .auth(self.http.put(format!("{}/keyfile", self.data_url)))
            .body(keyfile_json)
            .send()
            .await?;
        if !resp.status().is_success() {
            bail!("keyfile publish failed: {}", resp.status());
        }
        Ok(())
    }

    /// Fetch the server-published keyfile (web-access opt-in, R2.3) —
    /// the "phone path": any device with token + passphrase can unlock.
    /// Ok(None) = nothing published. Content is passphrase-wrapped, so
    /// holding it equals holding any device's keyfile.json.
    pub async fn get_keyfile(&self) -> Result<Option<Vec<u8>>> {
        let resp = self
            .auth(self.http.get(format!("{}/keyfile", self.data_url)))
            .send()
            .await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            bail!("keyfile fetch failed: {}", resp.status());
        }
        Ok(Some(resp.bytes().await?.to_vec()))
    }

    /// Remove the published keyfile. Returns whether one existed.
    pub async fn delete_keyfile(&self) -> Result<bool> {
        let resp = self
            .auth(self.http.delete(format!("{}/keyfile", self.data_url)))
            .send()
            .await?;
        if !resp.status().is_success() {
            bail!("keyfile removal failed: {}", resp.status());
        }
        #[derive(Deserialize)]
        struct R {
            removed: bool,
        }
        Ok(resp.json::<R>().await?.removed)
    }

    // ---------- write-only vault deposits (R2.7) ----------

    /// Publish/rotate the repo's X25519 deposit public key (owner, rw).
    pub async fn put_deposit_key(&self, pk_hex: &str) -> Result<()> {
        let resp = self
            .auth(self.http.put(format!("{}/deposit-key", self.data_url)))
            .body(pk_hex.to_string())
            .send()
            .await?;
        if !resp.status().is_success() {
            bail!("deposit-key publish failed: {}", resp.status());
        }
        Ok(())
    }

    /// Unpublish the deposit key. Returns whether one existed.
    pub async fn delete_deposit_key(&self) -> Result<bool> {
        let resp = self
            .auth(self.http.delete(format!("{}/deposit-key", self.data_url)))
            .send()
            .await?;
        if !resp.status().is_success() {
            bail!("deposit-key removal failed: {}", resp.status());
        }
        #[derive(Deserialize)]
        struct R {
            removed: bool,
        }
        Ok(resp.json::<R>().await?.removed)
    }

    /// Fetch the published deposit pubkey (deposit or rw token).
    /// Ok(None) = no key published (deposits disabled).
    pub async fn get_deposit_key(&self) -> Result<Option<String>> {
        let resp = self
            .auth(self.http.get(format!("{}/deposit-key", self.data_url)))
            .send()
            .await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            bail!("deposit-key fetch failed: {}", resp.status());
        }
        #[derive(Deserialize)]
        struct R {
            deposit_pk: String,
        }
        Ok(Some(resp.json::<R>().await?.deposit_pk))
    }

    /// Pending deposits with sealed payloads (owner review; rw token).
    pub async fn list_deposits(&self) -> Result<Vec<DepositRecord>> {
        let resp = self
            .auth(self.http.get(format!("{}/deposits", self.data_url)))
            .send()
            .await?;
        if !resp.status().is_success() {
            bail!("deposit list failed: {}", resp.status());
        }
        #[derive(Deserialize)]
        struct R {
            deposits: Vec<DepositRecord>,
        }
        Ok(resp.json::<R>().await?.deposits)
    }

    /// Remove a deposit after accept/reject (owner, rw). Idempotent.
    pub async fn delete_deposit(&self, id: &str) -> Result<bool> {
        let resp = self
            .auth(self.http.delete(format!("{}/deposits/{id}", self.data_url)))
            .send()
            .await?;
        if !resp.status().is_success() {
            bail!("deposit delete failed: {}", resp.status());
        }
        #[derive(Deserialize)]
        struct R {
            removed: bool,
        }
        Ok(resp.json::<R>().await?.removed)
    }

    /// POST one sealed deposit; returns the server's binding receipt.
    pub async fn post_deposit(&self, sealed: Vec<u8>) -> Result<DepositReceipt> {
        let resp = self
            .auth(self.http.post(format!("{}/deposits", self.data_url)))
            .body(sealed)
            .send()
            .await?;
        if !resp.status().is_success() {
            bail!("deposit failed: {}", resp.status());
        }
        Ok(resp.json::<DepositReceipt>().await?)
    }

    pub async fn get_blob(&self, id_hex: &str) -> Result<Vec<u8>> {
        let resp = self
            .auth(self.http.get(format!("{}/blobs/{id_hex}", self.data_url)))
            .send()
            .await
            .with_context(|| format!("blob download {id_hex}"))?;
        if !resp.status().is_success() {
            bail!("blob download {id_hex} failed: {}", resp.status());
        }
        Ok(resp.bytes().await?.to_vec())
    }
}
