# ShellX documentation workflow

ShellX product copy has one editable source: `docs/public/manual/shellx/content.json`.
The synchronized UI atlas is owned by `docs/public/manual/shellx/visuals.json` and
`docs/public/manual/shellx/assets/`. Do not hand-edit the generated Markdown or HTML
copies.

## Local editing loop

1. Update `docs/public/manual/shellx/content.json` and its `updated` field.
2. When UI changes, replace the relevant source-candidate capture under
   `docs/public/manual/shellx/assets/` and update its per-feature focus rectangle in
   `docs/public/manual/shellx/visuals.json`. Controls may share a capture only when the
   underlying UI state is genuinely identical. Capture ShellX surfaces from a
   production-mode Tauri renderer, not Vite/browser preview. A promoted image
   must not show preview-mode warnings, failed invokes, loading placeholders,
   private user data, or internal-only release tooling unless the corresponding
   article explicitly documents that exact state.
3. Run `pnpm docs:build` to regenerate `docs/public/SHELLX_MANUAL.md` and
   `docs/public/manual/shellx/index.html`.
4. Run `pnpm docs:check`, `pnpm docs:test-surfaces`, and
   `pnpm docs:test-sync`.

Before a capture can enter a frozen release candidate, change its `kind` to
`installed-candidate` and add a `review` record in `visuals.json` with the
installed-Tauri source, exact reviewed SHA-256, intended visible state, review
status, and timestamp. `pnpm docs:verify-atlas` rejects Vite/browser-preview
captures, blocked or missing reviews, byte drift, missing images, orphaned
captures, and features that point at a missing capture. This check is a release
gate; it is intentionally stricter than the routine documentation editing loop.

Use `pnpm docs:capture-atlas` only against an isolated installed-Tauri candidate
that already has a bound WebDriver session and private Debug API authentication.
Supply the exact loopback bases, session ID, process-local credential input,
source commit, version, platform, an
empty staging directory, and an existing synthetic app workspace whose leaf is
exactly `shellx-manual-demo`. The runner binds the active tab to that workspace
so captured Git, Files, and footer surfaces cannot expose an operator or release
profile path. The runner drives all 41 declared states and writes
PNG files plus `capture-manifest.json`; its status is deliberately
`captured-unreviewed`. Visually inspect every staged image before copying it into
the manual, changing `kind`, or adding review metadata. The runner refuses
unexpected dimensions and never promotes or marks captures reviewed itself.

The structured source version must match `package.json`. Generated output is
therefore tied to the exact source candidate rather than whichever release is
currently public.

## Interface-surface coverage

Do not collapse a menu, toolbar, rail, Settings screen, or Browser popover into
one generic feature description. Every persistent interactive surface must have
its own feature entry with a distinct name, explanation, and source mapping.

`pnpm docs:test-surfaces` verifies the current ShellX and Browser inventory
against stable markers in the shipping React components. It also verifies that
every interface article has a separate navigation link, a valid real-UI state,
and its own bounded highlight rectangle. The manual renders one interface image,
one movable highlight, and one detail panel at a time. A menu selection or deep
link updates that single map instead of repeating screenshots through the page.

A distinct base capture is required whenever the selection opens a different
Settings tab, right sidebar, bottom panel, menu, popover, or Browser side panel.
For example, selecting Files must show the Files sidebar open, and selecting
Settings: Vault must show the Vault Settings tab. The coverage gate rejects
repeated per-article figures and verifies these state mappings. `pnpm
docs:test-sync` runs the same coverage check and verifies that every atlas image
reaches the website source and staged public export.

When a persistent UI control is added, renamed, moved, or removed, update both
`docs/public/manual/shellx/content.json`, `docs/public/manual/shellx/visuals.json`, and
`scripts/test-shellx-docs-surface-coverage.mjs` in the same change.

## Website source

Synchronize or verify the local `docs.theshellx.com` source without deploying:

```bash
SHELLX_DOCS_SITE_ROOT=/path/to/docs-site pnpm docs:sync-site
SHELLX_DOCS_SITE_ROOT=/path/to/docs-site pnpm docs:check-site
```

This updates the ShellX manual, its static assets, the product card on the docs
home page, and tester-only `noindex,nofollow,noarchive` metadata. Search
indexing must remain disabled until a maintainer explicitly approves a public
documentation launch. Website deployment is a separate remote release
operation and requires its own explicit approval.

## Repository, website, and public export together

After the sanitized public-export checkout has been staged to the same version
as the working repository, synchronize all three targets with one command:

```bash
SHELLX_DOCS_SITE_ROOT=/path/to/docs-site \
SHELLX_PUBLIC_EXPORT_ROOT=/path/to/shellx-public-export \
pnpm docs:sync-all
```

Verify the complete handoff with `pnpm docs:check-all` and the same two
environment variables. The command copies the generated manual, structured
source, visual atlas, HTML, CSS, JavaScript, and UI captures into the
public-export checkout.

The generator refuses a public-export checkout whose package name or version
does not match the canonical source. This prevents the current released clone
from being silently mixed with unreleased documentation. It never deploys the
website and never pushes the public export.

## Public-export provenance and private-file boundary

`scripts/public_export.sh` stages only a committed ShellX source identity into
an empty destination. Its ordered policy is
`release/public-export-policy.json`. Every tracked path must resolve to an
explicit include or exclude rule with a category and reason; an unclassified
path fails the export instead of being copied by default.

Public application source, build and test tooling, deterministic release
contracts, and every file under `docs/public/` are intentional public inputs.
Working documentation that is not suitable for GitHub belongs under
`docs/private/`, which the exporter excludes as one directory boundary. Any
other `docs/**` path is unclassified and blocks export. Raw release receipts,
signing evidence, machine-local operations, worktrees, dependencies, caches,
and build output remain in private release-governance or governed local stores. A
public release contract is not a substitute for a private planning document:
move a document into `docs/public/` only when users or source-build reviewers
need it to understand, build, test, or verify the shipped product.

Each successful staging export writes:

- `PUBLIC_EXPORT_MANIFEST.txt` with the source commit and tree for operators;
- `PUBLIC_EXPORT_MANIFEST.json` with the source commit/tree, policy hash, every
  included file's path, Git mode, byte count, SHA-256, category, reason, rule
  id, and exact-or-prefix match trace. Excluded files are recorded only as
  counts by policy category; their private filenames and reasons are not copied
  into the public payload.

The JSON manifest is the review ledger for the current export. A file is
not eligible merely because it is tracked: its policy category and reason must
explain its public product, documentation, build, test, security, or
reproducibility purpose. `docs/public/` is the single positive documentation
root; workflow definitions, security policy, and agent resources remain
exact-path entries. The four intentional source-tree prefixes (`scripts/`,
`src/`, `src-tauri/`, and `vendor/`) reject artifact-like audit, plan, evidence,
receipt, report, review, research, snapshot, and dated files unless a
maintainer gives that path an exact include or exclude rule. Exact rules must
name a file in the selected source commit, so deleting or renaming a promoted
file also requires removing or updating its policy entry. Planning notes and
internal reviews stay under `docs/private/`; host receipts, signing operations,
and cleanup evidence stay in private release-governance storage even when they helped produce the
release. Review the complete included manifest path set and aggregate exclusion
category counts before promoting the staged checkout. The exporter accounts for
every source-tree path internally and fails on unclassified files without
disclosing the excluded path ledger in the output.

Review both sides of a disposable staged export instead of sampling filenames:

```bash
jq -r '.entries[] | [.path, .category, .reason, .ruleId, .matchedBy, (.matchedPath // "-")] | @tsv' \
  PUBLIC_EXPORT_MANIFEST.json
jq -r '.exclusions.byCategory | to_entries[] | [.key, .value] | @tsv' \
  PUBLIC_EXPORT_MANIFEST.json
```

Every included row must be necessary to use, understand, build, test, secure,
or reproduce ShellX. Inspect excluded source paths in the canonical working
tree or its private release-governance storage, never by copying their names into the public manifest.
A path inherited from a source prefix still needs a source-code purpose;
the match trace is not permission to retain a stale implementation, private
fixture, or planning artifact. Delete obsolete code from the canonical tree or
add an exact exclusion rather than using the public export as an archive.

The exporter verifies included bytes against the selected Git tree and scans
UTF-8, NUL-containing, and UTF-16 payloads for generic private-network and key
material markers before copying the payload. Private release governance applies the
project-specific host, operator, workspace, and secret-store marker set outside
the public repository. Marketing rasters under `docs/public/assets/` must also
match `reviewed-assets.json`, including exact output/source hashes and a
reviewed source. Ordinary UI marketing images remain bound to a reviewed
installed-candidate atlas capture. A purpose-built source under
`docs/public/marketing-sources/` must carry the same app version and product
source digest in its `sourceReview`; Browser sources assembled around a native
child WebView must also identify every exact component hash, live HTTPS URL,
installed engine bounds, and observation evidence. Generated pixels may be
used only for an outer presentation plate or for user content visibly opened
inside the unchanged installed UI.

When non-visual product bytes change without changing rendered UI, preserve the
original capture commit and review timestamp, re-inspect every promoted raster,
update its product-source digest, and add one top-level `revalidation` receipt
binding the current source commit, digest, review time, and private evidence
hash. Do not describe revalidated pixels as newly recaptured.

Run
`pnpm test:public-export` after changing the policy, exporter, documentation,
or tracked repository layout. Preview into a new empty temporary directory;
do not use the frozen `shellx-public-export` checkout as a scratch destination.

Tests and preview exports must own their temporary roots and remove them on
success, failure, and interruption. Generated test settings, browser profiles,
screenshots, compiled targets, and export previews are never release inputs and
must not be retained beside either persistent checkout.
