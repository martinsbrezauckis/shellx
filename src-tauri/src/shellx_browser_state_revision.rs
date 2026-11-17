use super::BrowserState;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hash, Hasher};
use std::sync::OnceLock;

pub(super) fn browser_title_revision(state: &BrowserState) -> u64 {
    // The title callback has no receipt and can share a millisecond with the
    // preceding navigation. A process-keyed digest detects the exact visible
    // title change without putting private History titles in a revision token.
    static HASHER: OnceLock<RandomState> = OnceLock::new();
    let mut digest = HASHER.get_or_init(RandomState::new).build_hasher();
    for tab in &state.tabs {
        tab.browser_tab_id.hash(&mut digest);
        tab.title.hash(&mut digest);
    }
    for engine in &state.engine_pool.engines {
        engine.engine_id.hash(&mut digest);
        engine.title.hash(&mut digest);
    }
    state.engine.title.hash(&mut digest);
    for visit in &state.history {
        visit.history_id.hash(&mut digest);
        visit.title.hash(&mut digest);
    }
    digest.finish()
}
