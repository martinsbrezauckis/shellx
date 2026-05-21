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
- `CHANGELOG.md` - release notes, with `Unreleased` updated as changes land.
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

## Pre-Push Check

Before pushing the public repo:

1. Run `rg -n "\\.project|private|notebook|night_run|mockups" .`.
2. Review every match as either public history, public source, or a bug.
3. Run the normal verification stack.
4. Update `CHANGELOG.md` under `Unreleased`.
