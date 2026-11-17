# ShellX vendor provenance: Wry 0.55.1

This directory is a source copy of the crates.io package `wry` version `0.55.1`,
used by ShellX's locked dependency graph. The pre-patch registry package
checksum recorded in `src-tauri/Cargo.lock` is:

```
186f9871daa55fd9c016578b810d149de58367113db7fb72b462d2323ce19514
```

The source was copied from the checksum-verified local Cargo registry
extraction after excluding only Cargo's extraction marker `.cargo-ok`.
`.cargo_vcs_info.json` is preserved because it is part of the upstream crate
archive. Upstream licensing is preserved in `LICENSE-APACHE`, `LICENSE-MIT`,
and `LICENSE.spdx`.

ShellX's patch preserves the exact application-selected destination for only
accepted downloads on macOS and Windows. On macOS it changes the Wry WKDownload
close lifecycle: Wry asks exact accepted controllers to cancel as the matching
WebView closes, and cancellation completion or a terminal delegate callback
sends at most one terminal result. An accepted original URL is held only as
transient Wry metadata while macOS cancellation is pending because WKDownload's
cancellation callback does not provide it. It is never persisted or exposed.
WKDownload resume data is ignored. Windows keeps the destination in
per-operation callback state, without retaining a COM controller or using a
raw controller identity. Without a terminal acknowledgement ShellX remains
cleanup-pending and retains its stage.

On Linux the default download-started callback is absent. ShellX installs its
WebKitGTK approval adapter before navigating a Browser WebView. Wry's upstream
allow-all default otherwise registers an earlier destination callback, writes
the attachment to its default folder, and prevents ShellX's approval callback
from running. Explicit Wry download callbacks remain available. This change
does not itself cancel downloads in WebViews without an application handler.
