# AGENTS.md — shellX repo agent rules

Scope: this directory tree. Applies to any agent (Codex, Claude, others)
operating inside the shellX repository.

## Destructive remote operations — require explicit user approval

NEVER run these without the user typing direct, per-operation approval
("yes, push" / "yes, tag" / "yes, release" for the specific action):

- `git push` to any remote (GitHub or otherwise)
- `git tag` followed by `git push --tags` or `git push origin <tag>`
- `gh release create / upload / edit / delete`
- `gh pr create` against any repo
- Any CI/CD trigger that publishes a release artifact (including
  `actions/upload-release-asset`, `tauri-action` with `publish: true`,
  etc.)
- Force-push (`git push --force`, `--force-with-lease`)
- Hard resets on a branch that has been pushed (`git reset --hard`
  past a pushed commit)

Approval is **per-operation**, not per-session. "Ship it" earlier in
the session does NOT carry over to a later push — re-ask each time.

Local commits, local tags, local branches, local builds: fine. The
trigger is the network publish or anything that mutates state on a
remote.

If unsure whether an operation reaches a remote, ASK before running it.

## Why this rule exists

On 2026-05-20 the shellX repo was pushed publicly to GitHub without
explicit user approval. The repo was thankfully still private and the
exposure was contained, but the lack of a per-operation approval gate
let an autonomous push happen. This rule closes that gap. The rule is
mirrored in `~/.codex/AGENTS.md` (codex home), `~/.claude/WORKFLOW.md`
(Claude Code), and `~/.grok/AGENTS.md` (grok-build agents in shellX
runtime) so every agent the user runs sees the same discipline.

## Other shellX-specific guidance

- Day-to-day ShellX development happens in `~/grok-shell`, not directly
  in this `~/shellx-public-export` staging checkout.
- `~/shellx-public-export` is the clean public GitHub staging checkout.
  Move only reviewed, pushable, bundled version-level changes there
  when preparing the next release. Do not trickle individual small WIP
  changes into the public export.
- A configured macOS builder is used for shellX macOS validation when
  needed. Keep hostnames, usernames, and other private lab details in
  local notes outside the public source tree.
- This repo is a Tauri 2 desktop app. Rust backend (`src-tauri/`),
  React + TS frontend (`src/`). Always run `cargo check --features
  debug-api` and `pnpm exec tsc --noEmit` after changes before
  reporting any task complete.
- Private notes, lab artifacts, and pre-release scratch live OUTSIDE
  this repo at `~/grok-shell-private/`. Do not commit anything under
  `.project/`, `evidence/`, or `screenshots/` — these are
  `.gitignore`d for a reason (see `docs/PUBLIC_REPO.md`).
- The `.shellx-managed-mcp` sentinel block in shellX's own config
  rewrites is the only auto-edited section. Everything else under user
  control stays user-edited.

## UI consistency

- Before changing ShellX UI, read `docs/SHELLX_UI_RULES.md` and keep
  new surfaces aligned with the existing token system, typography,
  spacing, modal structure, and action-button semantics.
