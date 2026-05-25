# Public Repo Boundary

This repository is intended to become the GitHub-facing shellX tree.
Anything private, experimental, or notebook-like belongs outside this
repo root.

## Rule

If a file is not needed by users, contributors, CI, build, installer, or
runtime, it does not belong in the public repo.

`.gitignore` is not a privacy boundary. Private notes must live outside
the public repo root, not as ignored files inside it.

## Public Sources Of Truth

- `README.md` - GitHub entry point.
- `CHANGELOG.md` - user-facing release notes, with `Unreleased` updated
  as changes land and promoted to a dated version before tagging.
- `docs/` - public architecture, API, threat model, and operator docs.
- `skills/shellx-host/SKILL.md` - bundled `shellx-host` skill source.
- `src-tauri/personas/*.md` - bundled subagent persona sources.
- `src/lib/builtin-docs.ts` - in-app About/Features/Quick-start docs.
- `.github/workflows/` - CI and release automation.

## Private Material

Keep these outside the public repo root:

- lab notes and scratch plans
- forensic audit dumps
- private feature notebooks
- internal mockups that are not part of the shipped source
- local screenshots, transcripts, and evidence captures
- private release checklists before they are promoted into `CHANGELOG.md`

## Release Readiness Checklist

Use the internal release-readiness checklist before staging or
publishing a release. It is the public release gate for version sync,
public-boundary review, Rust/TypeScript verification, CI parity,
artifact/signature checks, and explicit publish approvals.

This is an internal maintainer tool, not a normal product surface. The
About-tab panel is hidden in production builds unless shellX is built
with `VITE_SHELLX_INTERNAL_TOOLS=1`.

When a real release risk is found, add it to this checklist and cover it
in `scripts/test-release-readiness.ts`. Examples include the CI fake
`grok` shim (`GROK_BIN`) for tests that spawn Grok, Rust fmt/clippy with
warnings denied, dependency audit, and Windows installer signature/hash
presence.

The checklist is still partly manual. Keep improving it toward automatic
evidence collection instead of replacing it with private notes.

## Pre-Push Check

Before pushing the public repo:

1. Run `rg -n "\\.project|private|notebook|night_run|mockups" .`.
2. Review every match as either public history, public source, or a bug.
3. Use the internal release-readiness checklist as the release gate.
4. Run the normal verification stack.
5. Update `CHANGELOG.md` under `Unreleased`; keep entries short and
   user-visible.
6. Re-check README platform status if release artifacts changed.
7. Get explicit per-operation approval before any tag push, release
   publish, or other remote mutation.
