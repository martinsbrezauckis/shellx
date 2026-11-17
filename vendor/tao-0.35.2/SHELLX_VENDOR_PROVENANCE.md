# ShellX vendor provenance: Tao 0.35.2

This is the runtime source from the crates.io `tao` 0.35.2 archive, SHA-256
`a33f7f9e486ade65fcf1e45c440f9236c904f5c1002cdc7fc6ae582777345ce4`,
which was the checksum in ShellX's pre-patch Cargo.lock. Its Apache-2.0
`LICENSE` and `LICENSE.spdx` are preserved.

The only runtime edits are the four Windows source files in upstream merged
[Tao PR #1215](https://github.com/tauri-apps/tao/pull/1215), commit
`c704261c519c58cfdd0bc2d58ba24e06a0b71c92`. That patch moves
`PeekMessageW` calls before keyboard, layout and IME state locks so sent
focus messages can re-enter the Tao window procedure without self-deadlocking.
The exact Windows-only patch SHA-256 is
`acabe9ff9819a544e84a285dd74d782b2709039d72aa63014500bfcac0fb0848`.
All non-Windows runtime source files match the archive.

Package pruning is separate from the runtime patch: `Cargo.toml` no longer
lists upstream example targets or references the omitted README/examples.
All `src/**/*.rs` platform runtime modules and both license files are retained.
