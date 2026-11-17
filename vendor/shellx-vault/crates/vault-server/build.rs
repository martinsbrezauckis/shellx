//! Embeds optional standalone Vault web assets via memory-serve.
//! ShellX uses its own desktop Vault interface and does not bundle the
//! standalone web app. An empty asset directory keeps this embedded server
//! buildable when those optional assets are absent.

fn main() {
    let dist = std::path::Path::new("../../web/dist");
    // Keep a source build working when the optional web app is absent.
    if !dist.exists() {
        std::fs::create_dir_all(dist).expect("create web/dist placeholder");
    }
    memory_serve::load_directory(dist);
}
