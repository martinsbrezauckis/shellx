//! Live gate for `vault_client::items`.
//! against a real vault-server. NOT an installed command (the CLI
//! deliberately has no vault-read surface); a dev example only.
//!
//! Asserts the full host-bridge item lifecycle root-lessly (no sync dir):
//! save → list → read-back equality → upsert → delete → gone. Prints
//! PASS markers only — never item contents.
//!
//! Usage: items_smoke <server-url> <repo> <token> <keyfile.json>
//! Passphrase via SXVAULT_PASSPHRASE.

use anyhow::{bail, Context, Result};
use vault_client::client::Api;
use vault_client::items::{self, VaultItem};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let [_, server, repo, token, keyfile_path] = &args[..] else {
        bail!("usage: items_smoke <server> <repo> <token> <keyfile.json>");
    };
    let passphrase = std::env::var("SXVAULT_PASSPHRASE").context("SXVAULT_PASSPHRASE not set")?;
    let keyfile: vault_core::Keyfile =
        serde_json::from_str(&std::fs::read_to_string(keyfile_path)?)?;
    let master = keyfile
        .unlock(&passphrase)
        .map_err(|e| anyhow::anyhow!("unlock: {e}"))?;
    let api = Api::new(server, repo, token)?;

    let item = VaultItem {
        id: hex::encode(vault_core::random_bytes::<16>()),
        kind: "login".into(),
        title: "items-smoke entry".into(),
        username: "smoke@example.test".into(),
        password: hex::encode(vault_core::random_bytes::<12>()),
        url: "https://app.example.test/login".into(),
        notes: String::new(),
        created_ms: 1,
        updated_ms: 1,
    };

    let generation = items::save_item(&api, &master, "items-smoke", &item).await?;
    println!("PASS save (gen {generation})");

    let listed = items::list_items(&api, &master).await?;
    if !listed.iter().any(|i| i.id == item.id) {
        bail!("saved item missing from list");
    }
    println!("PASS list ({} item(s) visible)", listed.len());

    let back = items::read_item(&api, &master, &item.id)
        .await?
        .context("read-back missing")?;
    if back != item {
        bail!("read-back differs from saved item");
    }
    println!("PASS read-back byte-equal");

    // Upsert: same id, changed secret — must replace, not duplicate.
    let mut v2 = item.clone();
    v2.password = hex::encode(vault_core::random_bytes::<12>());
    v2.updated_ms = 2;
    items::save_item(&api, &master, "items-smoke", &v2).await?;
    let after = items::list_items(&api, &master).await?;
    let copies = after.iter().filter(|i| i.id == item.id).count();
    if copies != 1 {
        bail!("upsert produced {copies} copies");
    }
    let reread = items::read_item(&api, &master, &item.id)
        .await?
        .context("gone after upsert")?;
    if reread.password != v2.password {
        bail!("upsert did not replace content");
    }
    println!("PASS upsert (1 copy, new content)");

    // Origin binding helpers behave (lookalike must not match).
    if !items::domain_matches(&item.url, "app.example.test")
        || !items::domain_matches(&item.url, "sub.app.example.test")
        || items::domain_matches(&item.url, "evil-app.example.test.attacker.tld")
    {
        bail!("domain_matches rules wrong");
    }
    println!("PASS origin binding rules");

    let generation = items::delete_item(&api, &master, "items-smoke", &item.id).await?;
    if items::read_item(&api, &master, &item.id).await?.is_some() {
        bail!("item survived delete");
    }
    println!("PASS delete (gen {generation})");
    Ok(())
}
