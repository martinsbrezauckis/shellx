#![allow(clippy::await_holding_lock)]

mod browser_actions;
mod browser_workflows;
mod build_agent;
mod contract;
mod filesystem;
mod media_wire;
mod network_tools;
mod provider_handoff;
mod security_boundaries;

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    crate::test_env_lock()
}

struct EnvVarGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvVarGuard {
    fn set_str(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, previous }
    }

    fn unset(key: &'static str) -> Self {
        let previous = std::env::var(key).ok();
        unsafe {
            std::env::remove_var(key);
        }
        Self { key, previous }
    }

    fn set_path(key: &'static str, value: &std::path::Path) -> Self {
        let previous = std::env::var(key).ok();
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => unsafe {
                std::env::set_var(self.key, value);
            },
            None => unsafe {
                std::env::remove_var(self.key);
            },
        }
    }
}

mod tempdir_lite {
    use std::path::{Path, PathBuf};

    pub(super) struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        pub(super) fn new() -> Self {
            let unique = format!(
                "grok-shell-test-{}-{}",
                std::process::id(),
                super::now_ms_for_temp()
            );
            #[cfg(windows)]
            let base = std::env::current_dir()
                .expect("resolve Windows test checkout")
                .join("target")
                .join("shellx-host-mcp-tests");
            #[cfg(not(windows))]
            let base = std::env::temp_dir();
            let path = base.join(unique);
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        pub(super) fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

fn now_ms_for_temp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}
