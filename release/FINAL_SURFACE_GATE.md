# ShellX final surface gate

This is the last exhaustive acceptance pass for a release candidate. It is not a
development walkthrough and must not run after each fix.

## Run cadence and post-matrix fixes

Finish the implementation and its focused tests first, then freeze the exact
source, public export, signed artifacts, and installed candidates. Run this full
UI/UX matrix once, immediately before release, as the final exhaustive check of
the frozen candidate.

If that run exposes an isolated defect, record its blast radius and failing
evidence, apply the smallest fix, rebuild only the affected artifacts, and run a
separate targeted test block covering the changed area and its direct
dependencies. Attach that delta evidence to the original matrix receipt. Do not
repeat the complete matrix for a small, contained fix. Reopen and repeat the
full matrix only when the correction changes a deep or shared engine path, a
cross-cutting contract, release identity, or another interconnected area that
could invalidate unrelated results.

The cross-platform source/driver checks in GitHub CI are continuous contract
gates, not this final matrix. They prove that every declared surface remains
assigned and executable on each supported runner; the final matrix separately
proves intended effects and cleanup in the exact signed, installed candidates.

`surface-driver-plan.json` is the fail-closed implementation ledger. Its
`shellx/final-surface-driver-plan@2` model tracks every inventory ID on every
installed platform where that surface ships. A driver declares an independent
`building` or `ready` status for each platform, so a Windows/Linux WebDriver
implementation cannot silently claim macOS coverage. The final verifier refuses
all receipts until every exact surface-platform cell has one ready installed
driver assignment with a fixture, intended-effect assertion, and cleanup recipe.
`pnpm surface:driver-plan:check` reports this cell-level progress without running
the expensive cross-platform matrix.

Current synchronized ledger:

<!-- shellx-final-surface-ledger: {"status":"ready","inventoryItems":1909,"inventoryCells":5717,"assigned":5717,"ready":5717,"missing":0} -->

The marker is checked against the JSON ledger. It describes source-level driver
readiness only; installed candidate receipts, reviewed manual captures, and the
single final matrix are separate release gates.

The committed plan is inventory-synchronized. Every surface-platform cell must
always have an assignment, including unfinished work. `ready` assignments name
executable installed drivers; any unfinished exact surface is bound to a typed
`building` backlog driver with its intended fixture, semantic oracle, and cleanup
contract. Run `pnpm surface:driver-plan:write` after an inventory change. This
makes future implementation work explicit without treating a planned driver as
tested or release-ready.

`surface-inventory.json` uses the occurrence-aware
`shellx/release-surface-inventory@4` schema. Repeated UI controls and debug
markers remain separate IDs, event-propagation shields are accounted for but
excluded from the action ledger, and finite mapped registries such as Settings
tabs, right-rail tabs, transports, provider setup rows, and Vault choices expand
into one concrete surface per menu item. Runtime-owned wildcard IDs compile to
usable fixture selectors. Each item declares its real platform set and delivery boundary. In
addition, every exact UI occurrence declares a reusable driver family. User
controls retain their intrinsic tag, role/type where applicable, and
`eventTrust: native-required`; debug markers declare static or dynamic marker
families with no user-event claim. Selection, disclosure, toggle, value,
choice, range, and file-picker families have fixed semantic oracle contracts.
Activation controls require a surface-specific typed oracle, so visibility or
a resolved rectangle cannot satisfy their effect phase. Palette and keyboard
actions likewise cannot become ready while invoked only through synthetic
Debug API events.

In particular, the Browser CLI is currently classified as `source-package`; it
must not be described as an installed sidecar unless the release artifact
actually begins shipping it. Callable Host MCP compatibility aliases remain in
the inventory with `advertised: false`; hiding them from `tools/list` does not
remove their release-compatibility obligation.

A driver is not ready merely because its source path is listed. Ready drivers
must exist as regular repository files, answer the versioned `--describe`
protocol, explicitly advertise each fixture and cleanup recipe used by their
assignments, and emit exactly one identity-bound result for every requested
surface. Every result echoes the assignment's exact intended effect and names
the concrete oracle that judged the observed effect. The request, report, and
run manifest also bind the clean controller checkout's Git commit/tree, exact
Node and `tsx` loader hashes, driver-entrypoint hash, and any source executable
the driver launches. Browser CLI coverage therefore measures the exact tracked
`scripts/shellx-browser-cli.ts` source-package file rather than resolving an
ambient or stale checkout. Driver reports are create-only, reject undeclared
payload fields, retain failure details only as hashes, and include a
recomputable cleanup proof bound to the candidate instance and cleanup recipe.
Cleanup that can only be observed after the installed candidate exits is never
allowed to pass inside that still-running driver phase. The driver protocol
marks only the exact allowlisted candidate/profile teardown recipes as
`deferred-candidate-teardown`; every other cleanup remains an immediate pass or
fail. A deferred result is not a final surface pass. Final composition must
replace it with independently bound post-exit teardown evidence, and the final
receipt/verifier continue to require literal `pass` for every phase.

The bounded palette, keyboard-shortcut, and ShellX-command families are
source-ready on all three installed platforms except for native operating-system
picker actions. Windows and Linux use the external Tauri WebDriver lifecycle;
macOS uses the separately bound host-native input helper described below. This
is driver-plan readiness only. It does not replace a live receipt from each exact
signed and installed candidate.

The macOS native-input foundation is external release tooling under
`scripts/native/`; it is not a Tauri plugin and is not installed into the
shipping application. Its Swift helper binds the exact candidate PID,
canonical executable path and SHA-256, Accessibility window title, CoreGraphics
window number/owner/bounds, and AX WebArea before it can post a bounded native
event. A Debug API highlight challenge binds renderer viewport coordinates to
that native window and is removed even when proof fails. The binding receipt
stores hashes instead of raw selectors, titles, paths, or screen coordinates.

Accessibility is an explicit operator prerequisite. The helper only calls the
no-prompt `AXIsProcessTrusted()` and `CGPreflightPostEventAccess()` preflights;
it never requests, grants, resets, or changes macOS privacy settings. The
reusable macOS lane is deliberately two-phase: preparation builds a new helper
inside the exact disposable profile, launches and attests the installed
candidate, and leaves both alive; completion resumes only after the operator
manually grants Accessibility to that exact helper.

```bash
pnpm release:surface-prepare-macos-candidate -- \
  --candidate-stage signed-and-frozen \
  --execution-window immediately-before-publish \
  --run-id <16-to-64-lowercase-hex> \
  --artifact /private/path/shellX_<version>_aarch64.dmg \
  --installation-receipt /private/path/macos-installation.json \
  --application '/private/path/shellX.app/Contents/MacOS/shellX' \
  --profile /private/path/shellx-final-webdriver-<run-id> \
  --candidate-attestation-out /private/path/candidate.json \
  --helper-out /private/path/shellx-final-webdriver-<run-id>/shellx-release-macos-native-input \
  --preparation-out /private/path/preparation.json \
  --debug-port <unused-loopback-port> \
  --mcp-port <different-unused-loopback-port>
```

After the one manual Accessibility grant, create an empty provider evidence
directory and resume the same prepared candidate. This one command proves the
native-input binding, discovers and checks every rendered app link, subscribes
to the bounded release-only renderer-error ledger, runs all exact surface
drivers and provider routes, tears down the candidate/profile, and writes the
health, scenario, teardown, and orchestration receipts:

Every output and output directory in the completion command must be distinct
and outside `shellx-final-webdriver-<run-id>`; that profile is deliberately
removed during successful finalization and cannot hold durable release evidence.

```bash
pnpm release:surface-run-macos-candidate -- \
  --candidate-stage signed-and-frozen \
  --execution-window immediately-before-publish \
  --run-id <same-run-id> \
  --preparation /private/path/preparation.json \
  --artifact /private/path/shellX_<version>_aarch64.dmg \
  --signature-receipt /private/path/macos-signature.json \
  --installation-receipt /private/path/macos-installation.json \
  --candidate-attestation /private/path/candidate.json \
  --helper /private/path/shellx-final-webdriver-<run-id>/shellx-release-macos-native-input \
  --macos-native-input-binding-out /private/path/macos-native-input-binding.json \
  --driver-out-dir /private/path/drivers \
  --provider-route-plan /private/path/macos-installed-plan.json \
  --provider-route-out-dir /private/path/provider-routes \
  --health-out /private/path/health.json \
  --scenario-out /private/path/scenario.json \
  --profile-cleanup-out /private/path/profile-cleanup.json \
  --candidate-teardown-out /private/path/candidate-teardown.json \
  --orchestration-out /private/path/orchestration.json
```

The completion runner revalidates the helper bytes and candidate-bound receipt,
copies the exact receipt into its create-only evidence directory, and gives eligible macOS
drivers only bounded click, type, clear, key-chord, window, and native-picker
capabilities. Picker selection is additionally restricted to a canonical regular
file or directory below the exact `shellx-final-webdriver-<run-id>` profile whose
marker matches the candidate run. The helper binds exactly one candidate-owned
AX sheet/dialog, rejects renderer web content, uses the native Go-to-Folder
control, and returns only path/title hashes plus its root and candidate ownership
verdicts. Keyboard Attach, palette Attach, BottomPanel Attach/Folder,
AttachmentMediaBoard Attach, and both download-folder Choose controls share this
contract and must restore their exact tab, attachment, setting, Browser task,
window, and fixture state.

The lower-level finalizer remains independently callable for recovery or audit,
but ordinary G16 completion invokes it itself before receipt composition:

```bash
pnpm release:surface-finalize-macos-candidate -- \
  --run-id <16-to-64-lowercase-hex> \
  --candidate-attestation /private/path/candidate.json \
  --driver-manifest /private/path/drivers/run-manifest.json \
  --macos-native-input-binding /private/path/drivers/macos-native-input-binding.json \
  --profile-cleanup-out /private/path/profile-cleanup.json \
  --candidate-teardown-out /private/path/candidate-teardown.json
```

The finalizer remeasures the helper before teardown, verifies the candidate PID
and executable, stops only that process, proves the Debug API and MCP listeners
absent, removes the marker-owned profile, and emits the macOS branch of the
create-only candidate-teardown receipt. It never claims a WKWebView WebDriver
session.

On Windows and Linux, the same seven ShellX controls use the candidate-bound
native WebDriver action transport plus an isolated one-shot picker lease. The
lease accepts only one exact receipt-owned file or directory under the marked
run profile, is consumed through the production dialog wrapper, and is proved
cleared after the production handler changes the intended ShellX state. This
lane proves the ShellX control and handler outcome; it does not claim that the
operating system's picker window was opened or automated. Normal, non-isolated
instances have no lease and continue into the real OS dialog. Arbitrary renderer
scripts, arbitrary paths, and unbound dialog-result injection remain fail-closed.

Source-ready picker drivers and their local fail-closed tests do not constitute
release acceptance. The unchanged frozen candidates still require complete live
user-action/oracle/cleanup receipts. The macOS build receipt explicitly records
that its external helper is unsigned and is not installed into the application.

Run it only after the source commit is frozen, the release version is final, and
the exact Windows, macOS, and Linux artifacts have been signed or digest-verified.
The synchronized public manual must also contain only visually reviewed,
byte-bound installed-Tauri captures:

```bash
pnpm docs:verify-atlas
```

That verifier must pass before composing final receipts. A structurally complete
manual with preview-mode warnings, loading placeholders, internal-only tooling,
or changed-but-unreviewed PNG bytes is not release-ready.
Install those exact artifacts, exercise every item in `surface-inventory.json`,
and collect one private receipt per installed platform. Every surface must prove
presence, invocation, intended effect, and cleanup. Required transports and
providers must also pass, with zero broken links, silent skips, or unexpected
console errors. Receipt evidence identifiers must resolve to regular, non-symlink
files inside the private receipt directory; the verifier checks each exact byte
count and SHA-256 before accepting any outcome.

Trust boundary: this gate assumes a trusted local release operator, protected
workspace, and protected private receipt directory. Its hashes, create-only
writes, clean-source checks, and independent recomposition detect accidental
drift, stale evidence, corruption, and inconsistent summaries. They are not a
cryptographic authenticity chain against a malicious local writer who can
replace every candidate, evidence, and receipt JSON file consistently. In this
document, "attestation" means an identity-bound local observation record. A
future stronger boundary requires a candidate-held ephemeral signing key,
candidate-issued signed transcripts/nonces, and composer verification of that
key's binding to the signed distribution artifact. Do not describe the current
local evidence as tamper-proof or hostile-operator-proof.

Before a driver may run, create a parsed installation receipt and then a
candidate attestation from the exact installed payload and live process. For a
single-file development artifact, the bounded direct-stage adapter creates an
absent run-owned target, copies the artifact without overwrite, hashes the
complete one-file target twice, and writes a create-only receipt:

```bash
pnpm release:surface-install-direct -- \
  --platform <windows-installed|macos-installed|linux-installed> \
  --artifact <exact-candidate-artifact> \
  --target-root <absolute-absent-shellx-final-install-*-directory> \
  --payload-relative-path <single-runnable-filename> \
  --out <new-private-installation-receipt>
```

This receipt explicitly declares `staged-direct-file` payload coverage and
`not-observed` system-effect coverage. Windows payload snapshots are collected
through native PowerShell, reject junctions/reparse points before traversal,
and record whether Windows or WSL orchestrated the native collector. It is not
installer evidence and cannot substitute for the native NSIS, DMG, or Linux
package adapters required for a
shipping installer candidate. The candidate-attestation command requires the
parsed platform installation receipt. Its `/health` identity response plus a
protected `/browser/state` probe bind the
frozen source commit, application version, OS process ID, per-launch instance
nonce, exact credential file, and `http://127.0.0.1:<port>` debug origin to the
installed executable bytes:

```bash
pnpm release:surface-attest-candidate -- \
  --platform <windows-installed|macos-installed|linux-installed> \
  --artifact <exact-candidate-artifact> \
  --installed-payload <exact-installed-main-executable> \
  --installation-receipt <parsed-platform-installation-receipt> \
  --pid <live-installed-candidate-pid> \
  --debug-base http://127.0.0.1:<exact-port> \
  --debug-token-file <exact-isolated-candidate-token-file> \
  --mcp-base http://127.0.0.1:<exact-host-mcp-port> \
  --mcp-token-file <exact-isolated-host-mcp-token-file> \
  --out <new-private-candidate-attestation>
```

Only the credential file paths are recorded in private evidence. Token values
are never serialized; they are read directly for protected probes and each
driver run so token discovery cannot drift to another ShellX home.

The current attestation schema is a fail-closed foundation for the final gate,
not evidence that the platform adapters are complete. Candidate creation and
the runner's mandatory before/after probes now record and compare native
process-start identity, executable file identity/hash/size, exact loopback
listener, and socket-owning PID on Windows, Linux, and macOS. Windows uses its
process creation epoch and NTFS volume/file ID. Linux uses the kernel boot ID
plus process start ticks, executable device/inode, and the exact `/proc/net/tcp`
socket inode proved present in the candidate PID's descriptor table. macOS uses
the native `ps` start epoch, executable device/inode, and a unique exact-address
`lsof` loaded-executable vnode plus a unique exact-address listener owner. Every
collector double-reads the process, executable,
hash, stable file identity, and listener before emitting evidence; PID reuse,
executable replacement, or listener handoff during collection therefore fails
closed. POSIX request/run bindings carry only the executable basename and a
SHA-256 path identity, not a raw machine path.

The direct-stage adapter now records and
rechecks its entire one-file target at receipt creation, candidate attestation,
and before and after the driver run. Windows uses the native PowerShell payload
collector rather than treating an NTFS target as a POSIX tree. The Windows NSIS
adapter now observes the signed installer, complete installed target, exact HKCU
registrations, `/NS` shortcut suppression, silent Explorer-handoff suppression,
stable pre-existing WebView2, and lack of process auto-launch or machine-wide
registration. It is intentionally restricted to a fresh named non-admin
disposable Windows user:

```bash
pnpm release:surface-signature-windows -- \
  --artifact 'C:\\path\\to\\exact-signed-shellx-setup.exe' \
  --signing-metadata <private-Azure-Artifact-Signing-metadata.json> \
  --out <new-private-Windows-signature-receipt>

pnpm release:surface-install-windows-nsis -- \
  --artifact 'C:\\path\\to\\exact-signed-shellx-setup.exe' \
  --signature-receipt <exact-Windows-signature-receipt> \
  --target-root 'C:\\Users\\<fixture>\\AppData\\Local\\ShellXReleaseEvidence\\shellx-final-install-<nonce>' \
  --expected-user '<MACHINE>\\<fixture>' \
  --out <new-private-installation-receipt>
```

The structured signature receipt runs SignTool `/pa` verification and native
Authenticode inspection. It binds the artifact bytes to the U1C publisher,
Microsoft issuer policy, and a timestamp certificate. It separately proves that
the supplied private signing metadata is internally consistent and binds its
runtime provider identifiers inside the private receipt; Authenticode alone cannot prove which
service account/profile performed signing, so the receipt describes that part
as verification policy, not signing provenance. Non-certificate provider
identifiers remain private. Rotating leaf and timestamp thumbprints are
recorded as evidence but are not used as the stable publisher identity.

The receipt-bound target remains installed while candidate attestation and all
surface drivers run. Finalize it only afterward. The finalizer rechecks the
complete native manifest and exact uninstaller hash, runs the uninstaller with
its receipt-owned target, preserves unexpected residuals, and never recursively
deletes the install tree:

```bash
pnpm release:surface-finalize-windows-nsis -- \
  --installation-receipt <parsed-Windows-installation-receipt> \
  --expected-user '<MACHINE>\\<fixture>' \
  --out <new-private-finalization-receipt>
```

The macOS DMG lane follows the same receipt-bound lifecycle without launching
the application. First create a private user-owned evidence parent, then create
the signature receipt from the exact frozen DMG:

```bash
install -d -m 700 "$HOME/Library/Application Support/ShellXReleaseEvidence"

pnpm release:surface-signature-macos -- \
  --artifact /absolute/path/to/shellX_<version>_<arch>.dmg \
  --out <new-private-macOS-signature-receipt>
```

The native collector mounts that exact DMG read-only with Finder browsing and
auto-open disabled. It requires exactly one top-level `shellX.app`, verifies
the frozen team ID `4M329JW6R4` and bundle ID `lv.shellx.app`, runs `codesign`
with deep, strict, and all-architecture verification, requires Gatekeeper to
accept the app as `Notarized Developer ID`, and validates stapled tickets on
both the app and DMG. It detaches the exact mounted device before its
create-only receipt can be written.
This implements Apple’s documented
[deep/strict and Gatekeeper checks](https://developer.apple.com/library/archive/technotes/tn2206/)
and its guidance to
[staple notarization tickets to distributed software](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

Install the receipt-approved DMG into one absent, run-owned application target:

```bash
pnpm release:surface-install-macos-dmg -- \
  --artifact /absolute/path/to/shellX_<version>_<arch>.dmg \
  --signature-receipt <exact-macOS-signature-receipt> \
  --target-app "$HOME/Library/Application Support/ShellXReleaseEvidence/shellx-final-install-<nonce>.app" \
  --out <new-private-macOS-installation-receipt>
```

The adapter exclusively creates the target, copies the mounted app with
`ditto`, compares complete source and target manifests, re-verifies code signing
and Gatekeeper on the copied app, proves no `shellX` process existed before or
after copy, and detaches the exact image. Its declared system effects are only
the run-owned app copy, temporary read-only image lifecycle, and no-autolaunch
observation. It never calls `open` and never replaces an existing app.

After candidate testing, finalize only the unchanged receipt-bound target:

```bash
pnpm release:surface-finalize-macos-dmg -- \
  --installation-receipt <parsed-macOS-installation-receipt> \
  --out <new-private-macOS-finalization-receipt>
```

The finalizer re-collects the complete app manifest, requires the recorded mount
point to remain absent and no `shellX` process to exist, then deletes only the
exact manifest entries. It does not use recursive deletion and preserves a
changed or unexpected target for investigation.

Do not run the Windows NSIS install/finalize commands in a normal user profile
or on a machine with an existing ShellX installation. The Windows adapter
refuses an administrator, an existing
HKCU or machine registration, an existing ShellX process, a mapped/SUBST/reparse
target, or missing WebView2. Its first live release proof still requires two
independently fresh disposable-user or VM states. If either native operation
times out or any post-launch condition fails, the fixture is poisoned: preserve
its partial state for diagnosis, then dispose the entire user profile or revert
the VM before retrying. A failed operation must never be finalized through the
passing-receipt path. If exact-PID tree termination itself fails, profile cleanup
is insufficient: revert the whole VM and record the surviving PID from the
failure. The Debian shipping-package
adapter now covers the Linux package payload path, but it is
deliberately narrower than a system package-manager installation. Run it on a
native, non-WSL Linux host as a non-root disposable user, with the exact `.deb`
outside an empty mode-0700 `shellx-final-linux-run-*` root:

```bash
pnpm release:surface-signature-linux -- \
  --artifact /private/path/shellx_<version>_<architecture>.deb \
  --out <new-private-Linux-digest-receipt>

pnpm release:surface-install-linux-deb -- \
  --artifact /private/path/shellx_<version>_<architecture>.deb \
  --signature-receipt <exact-Linux-digest-receipt> \
  --target-root /private/path/shellx-final-linux-run-<nonce>/shellx-final-install-<nonce> \
  --out <new-private-installation-receipt>
```

The adapter parses the real Debian control archive, binds package name, version,
architecture, exact artifact bytes and SHA-256 receipt, then uses only
`dpkg-deb --extract` into the absent receipt-owned target. It inventories but
does not execute `preinst`, `postinst`, `prerm`, or `postrm`. It double-collects
the complete target manifest, requires `usr/bin/shellx` to be executable, and
proves that the dpkg status digest, known desktop/autostart/service targets, and
ShellX process set did not change. This is shipping-package payload evidence;
it is not evidence of distro registration, dependency resolution, maintainer
script behavior, desktop integration, upgrade, or uninstall through `apt` or
another package manager. Direct-stage evidence remains a separate development
path and cannot satisfy this package adapter.

Keep the receipt-owned target unchanged while candidate attestation and all
drivers run. Finalize only after the run:

```bash
pnpm release:surface-finalize-linux-deb -- \
  --installation-receipt <parsed-Linux-installation-receipt> \
  --out <new-private-finalization-receipt>
```

The finalizer re-collects the exact manifest, refuses active target processes or
host-state drift, removes only receipt-listed files and directories, removes the
now-empty owned run root, and never uses recursive deletion. Any mismatch is
fail-closed and preserves the target for diagnosis. WSL can run the real `.deb`
fixture test, including proof that a fixture `postinst` was not executed, but it
cannot create a passing shipping receipt. Native Linux acceptance using the
actual frozen `.deb` remains required. If the release intends to claim normal
distro package installation rather than bounded package-payload acceptance, a
separate disposable VM package-manager lane remains a blocker only if that
normal package-manager behavior will be claimed for the release.

The macOS DMG signature, copy-install, and exact finalization adapters have
Linux-runnable parser, contract, adversarial-copy, and manifest-bound cleanup
tests. They still require first live acceptance on the dedicated native macOS
host using the actual frozen, signed, notarized, and stapled DMG. The Linux
adapter likewise still requires acceptance of the actual frozen `.deb` on a
native non-WSL Linux host. Until both native-host receipts exist, the final
cross-platform gate remains incomplete even when these development tests pass.

Verify the collected private receipts with:

```bash
pnpm release:surface-verify -- --receipts-dir <private-receipts-directory>
```

After all signed updater artifacts are frozen, verify their updater signatures,
generate `latest.json`, then create the public checksum manifest from the exact
release-asset staging directory:

```bash
pnpm release:updater-verify -- --artifact-root <release-assets-directory> --version <version> --tag v<version>
pnpm release:updater-manifest -- --artifact-root <release-assets-directory> --version <version> --tag v<version>
pnpm release:checksums -- --artifact-root <release-assets-directory>
(cd <release-assets-directory> && sha256sum -c SHA256SUMS)
```

`latest.json` must never be hand-authored or edited after generation. Any
artifact, `.sig`, updater manifest, or checksum change invalidates this step and
requires regenerating and rechecking `SHA256SUMS`. Publish `SHA256SUMS` beside
the release assets so users can verify downloaded bytes independently of the OS
signature UI.

When the ledger reaches `READY`, the lower-level Windows/Linux driver command
can run against an already-owned live session for fixture development:

```bash
pnpm release:surface-run-drivers -- \
  --candidate-stage signed-and-frozen \
  --execution-window immediately-before-publish \
  --platform <windows-installed|linux-installed> \
  --artifact <exact-candidate-artifact> \
  --signature-receipt <exact-signing-receipt> \
  --candidate-attestation <exact-live-candidate-attestation> \
  --installation-receipt <parsed-platform-installation-receipt> \
  --webdriver-session <private-live-session-json> \
  --out-dir <new-private-evidence-directory>
```

It is not the final gate and cannot be used for macOS. Windows/Linux
final-candidate work must
instead enter through the owned lifecycle so the session cannot come from a
different smoke run; macOS uses the two-phase prepare/resume lane above:

```bash
pnpm release:surface-run-webdriver-candidate -- \
  --candidate-stage signed-and-frozen \
  --execution-window immediately-before-publish \
  --platform <windows-installed|linux-installed> \
  --run-id <16-to-64-lowercase-hex> \
  --artifact <node-readable-candidate-artifact> \
  --signature-receipt <exact-signing-receipt> \
  --installation-receipt <parsed-platform-installation-receipt> \
  --application-launch <native-installed-executable-path> \
  --application-node <node-readable-installed-executable-path> \
  --tauri-driver <absolute-tauri-driver-command> \
  --tauri-driver-node <node-readable-tauri-driver-path> \
  --native-driver <native-driver-launch-path-if-Windows> \
  --native-driver-node <node-readable-native-driver-path-if-Windows> \
  --profile-node <absent-node-readable-shellx-final-webdriver-run-directory> \
  --profile-launch <matching-native-profile-path> \
  --debug-port <reserved-port> --mcp-port <reserved-port> \
  --driver-port <reserved-port> --native-port <reserved-port> \
  --health-port <reserved-port> \
  --provider-route-plan <exact-cross-product-plan-json> \
  --provider-route-out-dir <new-private-provider-route-directory> \
  --health-out <new-private-health-evidence> \
  --scenario-out <new-private-scenario-report> \
  --candidate-attestation-out <new-private-attestation> \
  --driver-out-dir <new-private-driver-evidence-directory> \
  --lifecycle-out <new-private-lifecycle-receipt> \
  --profile-cleanup-out <new-private-cleanup-receipt> \
  --candidate-teardown-out <new-private-candidate-teardown-receipt> \
  --orchestration-out <new-private-orchestration-receipt>
```

This entry point creates the WebDriver session, waits for the exact isolated
Debug API identity, creates candidate attestation inside that same live session,
runs the driver matrix with the in-memory session, saves only the plan-declared
disposable connection presets, collects the exact provider × transport batch,
and observes the complete rendered-link inventory plus WebView console stream
from that same candidate process. It then deletes the session, proves the exact
candidate PID absent through the target OS, writes health/scenario evidence,
and proves driver/profile cleanup. The post-exit
`shellx/release-surface-candidate-teardown@2` receipt binds the exact candidate
attestation and driver-run manifest to successful WebDriver deletion on
Windows/Linux or to the exact macOS native-input binding, plus native process
absence, zero Debug API/MCP listeners, zero owned driver processes, and
marker-verified profile removal. It never accepts a serialized session ID. Its orchestration receipt
binds attestation, driver-run, provider-route, health, scenario, lifecycle,
executable, cleanup, and candidate-teardown hashes. Missing live candidate
receipts—not post-hoc Windows/Linux health—keep G16 incomplete.

The private WebDriver session JSON contains only the exact loopback `base` and
opaque `sessionId` for a still-live session that launched the installed payload.
It is mandatory on Windows/Linux as soon as the platform has any ready
installed-input or renderer-command driver; non-WebDriver drivers never receive
it. Before the first such driver runs, the runner posts a fresh random
highlight challenge to the attested candidate Debug API, requires that exact
label to appear through the supplied WebDriver session, clears it through the
candidate, and requires both sides to observe cleanup. The resulting
create-only `shellx/release-surface-webdriver-binding@2` receipt stores the
candidate PID/instance and only hashes of the session ID and observed window
title. This binds native UI events to the same renderer/runtime as the candidate
attestation instead of accepting a separate WebDriver smoke from another app
process or retaining renderer title payloads.

Official external `tauri-driver` directly covers Windows and Linux, not macOS.
The newer embedded WebDriver plugin can cover macOS but must not be added to the
shipping release binary merely to make G16 green. The macOS installed-action
lane uses an external host-native Accessibility/event helper bound to the same
candidate identity. Its exact binding receipt is part of driver requests, reports,
the driver-run manifest, and final receipt composition. The currently assigned
palette actions use native installed-input clicks and exact visible-effect
selectors, including an explicit Work Preview work-mode selector. A reusable
external-driver lifecycle
owner now creates and deletes one exact installed-payload session, terminates its
owned driver process on success or failure, and records only session/log hashes.
Twelve keyboard rows and all seven ShellX-command rows also have native W3C
key-action or installed-input drivers, exact effects, key-source release, and
cleanup tests. Four bottom-panel tabs use native clicks plus exact
renderer/owner-state oracles. The Connectors lane exercises reversible unsaved
provider, receiver, delivery, Vault-key-reference, allowlist, and target-mode
drafts. The production lane also
proves owned refresh, save, simulate, test, and delete lifecycle effects.
Synthetic token values are write-only, deliberate pre-network fixtures prevent
external calls, and evidence retains no token, Vault-key, allowlist,
fixed-session, sender, conversation, or message contents. The four-state per-tab
ShellX tool-exposure selector also exercises
Native, Bridge, Full, and Off through native clicks, confirms the exact active-tab
backing state after each choice, and restores both the prior mode and right-rail tab
without launching an agent; its pressed state and non-sensitive exposure mode are
the only evidence fields. All current UI-control platform cells have source-ready
drivers. A cross-platform run-profile owner creates only an absent
`shellx-final-webdriver-<run-id>` profile,
bridges its isolated environment to the native app, verifies its ownership
marker, stops only an exact PID/image and Windows native-driver port identity,
uses native `lsof` for macOS process/listener proof, checks the target OS for
zero candidate listeners, and writes create-only
`shellx/release-surface-run-profile-cleanup@1` evidence
before removing it. The surface-driver orchestrator now binds that owner to
candidate attestation, provider-route batch, and the same live WebDriver session
through `shellx/release-surface-webdriver-orchestration@4`. The 147 executable
Tauri-command assignments do not execute arbitrary renderer JavaScript or expose
raw `window.__TAURI_INTERNALS__.invoke`. On all three platforms, the installed
app instead uses a nonce-bound, authenticated, isolated-profile relay through
the Debug API. The shipping renderer claims only a plan-allowlisted command,
invokes it with bounded arguments, completes a bounded result, and deletes its
temporary relay state. The driver proves claim, completion, deletion, and
cleanup. Read commands validate bounded schemas; mutating commands use owned
disposable fixtures, exact expected rejections, or explicit cleanup/restore
contracts. Reports omit paths, Vault identifiers, task commands, task output,
and private values. Windows Explorer context-menu install/remove use a disposable
HKCU lifecycle; trusted-page Vault fill uses hash-only field evidence; and the
Grok launch driver initializes and aborts one owned local ACP child without
sending a provider prompt. This lane
includes the Agent CLIs live setup state and exact-target provider scan, so the
pre-release matrix must observe current versions and executable identities before
any provider is launched instead of accepting a persisted last-run version. All
current user-action families have source-ready assignments; the release runner
must still fail closed rather than reuse an unrelated smoke session.

The runner refuses dirty source, an incomplete driver ledger, existing output,
symlinked evidence inputs, or reports that omit or duplicate a platform-applicable
inventory ID. Every installed driver re-probes only the attested loopback origin
and must echo the exact process ID, instance nonce, executable hash, and installed
payload path. The runner—not the driver—also writes and validates authenticated
before/after runtime probes plus platform-native continuity evidence, so a
driver cannot opt out of binding and a process restart, executable replacement,
or listener handoff during execution fails the run. It rechecks the clean
controller tree and all measured executable identities after every driver and
again before sealing
the run manifest, so source/dev/old-package substitution fails closed. It excludes
explicitly non-applicable platform rows instead of recording a silent skip.

The owned runner consumes one
`shellx/release-surface-provider-route-batch-plan@1` plan containing the exact
provider × transport cross-product for its platform. Each row carries a
secret-free saved connection preset, disposable cwd, and explicit destination
host OS where required. The route artifact then records the resulting destination
OS, runtime, and effective shell (`powershell`, `posix-shell`, or `wsl-bash`).
The runner rejects missing, duplicate, extra, or
transport/runtime-mismatched rows before launching the candidate. It reads the
candidate's current preset IDs before mutation, refuses any batch ID that
already exists, and removes every batch-owned preset after success or failure.
Cleanup failure prevents the batch manifest from being written. The runner
writes each route evidence file create-only and binds the resulting
`shellx/release-surface-provider-route-batch@3` manifest into the orchestration
receipt before shutdown.

Each platform run must also produce one
`shellx/release-surface-scenario-report@4` file. That report is separate from
the surface drivers: it binds the exact artifact/source identity to the exact
provider × transport cross-product, rather than accepting unrelated aggregate
claims that a provider passed somewhere and a transport passed somewhere. Each
route records the app host platform, destination host OS, native Windows/POSIX
or explicit WSL runtime, its exact PowerShell/POSIX/WSL-Bash shell kind,
privacy-preserving host fingerprint, resolved provider executable hash and
size, and tested CLI version. Native Windows over OpenSSH and an explicitly
selected WSL distro behind Windows OpenSSH are different required routes; WSL is
never an implicit fallback. Every route must pass a fresh capability scan that
actually resolves and versions the exact executable over its declared
transport. A coverage-minimal declared subset also runs the bounded normalized
provider stream: every provider is live at least once across the three-platform
matrix, every required transport is live on each installed app OS, and those
canaries require zero parse errors, zero event gaps, and successful cleanup.
Identity-only routes never open a provider stream and cannot claim a canary.
The same report also proves
healthy startup and shutdown, zero broken links, and zero unexpected console
errors. A missing, duplicated, failed, or undeclared route fails receipt
composition. A route summary is not evidence by itself. Before assembling the
scenario report, collect every route through the create-only live collector:

```bash
pnpm release:surface-collect-provider-route -- \
  --candidate-attestation <exact-live-candidate-attestation> \
  --preset <exact-connection-preset-json> \
  --provider <grok|codex-cli|claude-code|antigravity-cli> \
  --transport-id <local-native|local-wsl|ssh-posix-native|ssh-windows-native|ssh-windows-wsl> \
  --evidence-mode <identity-only|live-canary> \
  --target-host-os <linux|macos> \
  --cwd <safe-disposable-fixture-cwd> \
  --out <new-private-route-evidence-file>
```

`--target-host-os` is required only for `ssh-posix-native`. Grok collection
requires the exact preset to be saved already; the collector never creates or
rewrites a user's connection. Run the collector from its canonical clean Git
checkout: it fails unless `HEAD` exactly equals the candidate source commit and
the collector implementation is tracked. Store outputs under the ignored
private `release-evidence/` tree (or outside the checkout) so sequential route
collections do not dirty the source tree. Every `shellx/release-surface-provider-route-evidence@3`
file binds the attested ShellX PID/instance, authenticated health before and
after the run, a fresh v2 capability snapshot, exact executable identity, the
declared identity-only or live-canary mode, and cleanup. Live-canary evidence
also binds the authenticated WebSocket stream with zero lag warnings, raw event
payload hashes and bytes, the provider-native normalized sequence, and the
fixed bounded canary. Identity-only evidence requires an unopened event stream,
zero frames, and an explicit no-run cleanup state. Each scenario route references the resulting file by
basename, SHA-256, and byte count. The composer reopens every route artifact,
recomputes its raw payload identities, and rejects summary drift, capability
drift, unauthorized live-generation expansion, sequence gaps, forged canary
claims, or missing cleanup.

Overall startup/link/console/shutdown health must have a separate
`shellx/release-surface-health-evidence@1` artifact; pass/zero fields written
only into the scenario report are rejected. The owned Windows/Linux runner
records the exact candidate `/health` response, injects a sequenced WebView
observer before the scenario, discovers every platform anchor surface through
installed WebDriver, checks its HTTP target, and keeps the authenticated
loopback collector alive through the exact session DELETE and candidate PID
exit. The macOS completion runner observes the same bounded HTTPS anchor set
through its candidate-bound native-input helper and keeps an authenticated
renderer-error WebSocket subscription through native teardown. Sequence or
subscription gaps, unknown or missing link surfaces, broken targets,
unexpected console errors, or a surviving PID fail the lifecycle. The
low-level draft validator remains available for schema development:

```bash
pnpm release:surface-create-health-evidence -- \
  --draft <health-driver-raw-draft-json> \
  --candidate-attestation <exact-live-candidate-attestation> \
  --scenario-started-at <iso-start> \
  --scenario-completed-at <iso-observed-shutdown> \
  --out <new-private-health-evidence-file>
```

The creator validates internal derivation, requires a canonical clean checkout
at the exact candidate commit with tracked creator sources, and uses a
create-only write. It does not discover links, subscribe to WebView console
events, or observe process exit itself, so its operator-authored draft is not a
substitute for the owned final runner.
The trusted-local-operator boundary above still applies. Receipt composition
reopens this file, verifies its scenario-declared hash/size, re-derives the
zero counts from its observations, and makes the final health row cite this
artifact rather than the scenario summary.

Keep the driver run directory, the exact signature receipt used by the runner,
and the scenario report beneath one new private receipts directory. Compose one
top-level platform receipt only after all three evidence groups pass:

Each platform directory also owns its scenario-declared health and
provider-route JSON evidence. Their basename-only identities are independently
reopened beside that platform's scenario report, so evidence from different
platforms cannot collide. At the root, the verifier discovers only the three
exact `<platform>-receipt.json` filenames declared by the contract; raw JSON
evidence is not parsed as a final receipt.

```bash
pnpm release:surface-compose -- \
  --platform <windows-installed|macos-installed|linux-installed> \
  --receipts-dir <private-receipts-directory> \
  --driver-run-dir <private-receipts-directory>/<platform>/driver-run \
  --scenario-report <private-receipts-directory>/<platform>/scenario-report.json \
  --signature-receipt <private-receipts-directory>/<platform>/signature.json \
  --candidate-attestation <private-receipts-directory>/<platform>/candidate-attestation.json \
  --candidate-teardown <private-receipts-directory>/<platform>/candidate-teardown.json \
  --installation-receipt <private-receipts-directory>/<platform>/installation.json \
  --out <private-receipts-directory>/<platform>-receipt.json
```

The composer re-hashes every request, report, scenario, run manifest, signature
receipt, candidate attestation, candidate teardown, WebDriver lifecycle,
run-profile cleanup, and parsed installation receipt;
requires every native check declared by `surface-contract.json`; revalidates driver requests
against the exact inventory and assignment ledger; and makes every final
surface outcome point to the driver report that proved it. Cleanup that was
deferred while the candidate remained live receives a separate pointer to the
recomposed teardown receipt; other cleanup keeps the driver-report pointer. It refuses evidence
outside the private receipts tree, symlinks, source drift, a dirty checkout, or
an output overwrite. The final verifier independently recomposes every supplied
platform receipt from those raw files and rejects a top-level pass receipt that
is hand-authored without the complete internally consistent evidence set, or
that has drifted from that set. This is deterministic consistency under the
trusted-local-operator boundary above, not cryptographic proof of who created
the evidence.

Any source, inventory, artifact, or signature change invalidates all receipts.
Freeze and build again, then rerun the complete cross-platform gate immediately
before requesting approval for remote publication.

`pnpm test:ui-state-space` is a fast development gate. It breadth-first walks
600 bounded high-level navigation states across right/bottom tabs, conditional
media states, modals, Settings tabs, composer lock states, and representative
wide/compact/narrow viewports. It rejects unreachable states, dead or
nondeterministic actions, trapped return paths, registry/selector drift, and
missing responsive or reduced-motion contracts. The production renderer and
the walker share the canonical navigation registries in
`src/lib/ui-navigation.ts`.

This source-level state model can catch interaction-graph regressions early,
but it does not render or invoke an installed binary. Passing it is not a
substitute for any exact installed surface driver or signed-and-frozen receipt.

The development command `test:shellx-visible-surface-walkthrough` checks a small
visible UI sample only. Its result is never release-completeness evidence.
