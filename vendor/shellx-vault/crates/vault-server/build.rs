//! Embeds the web SPA (web/dist) into the binary via memory-serve.
//! Release builds carry the assets inside the executable (single-binary
//! deploy); debug builds read the directory at request time (dev velocity).
//! BUILD ORDER: `pnpm run build` in web/ BEFORE `cargo build --release`,
//! or the embedded UI is stale/empty.

fn main() {
    let dist = std::path::Path::new("../../web/dist");
    // Keep plain `cargo test`/`cargo build` working on a fresh checkout
    // where the web app was never built: embed an empty dir instead of
    // failing the whole workspace build.
    if !dist.exists() {
        std::fs::create_dir_all(dist).expect("create web/dist placeholder");
    }
    memory_serve::load_directory(dist);
}
