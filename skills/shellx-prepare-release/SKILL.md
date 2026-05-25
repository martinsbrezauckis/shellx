---
name: shellx-prepare-release
description: >
  Use for preparing a release from shellX: version checks, changelog,
  verification, packaging, artifact review, and publish-readiness.
metadata:
  short-description: Prepare a release with explicit checks and no surprise publishing
---

# Prepare Release

Standardize the release without publishing by accident.

1. Check git status and current branch. Do not push, tag, create a release, or
   upload artifacts unless the user gives explicit per-operation approval.
2. Confirm version consistency across app manifests.
3. Check changelog/release notes for the target version.
4. Run required verification commands for the repo.
5. Build packages for requested platforms and record artifact paths.
6. Inspect updater/release metadata if the app uses auto-update.
7. Present a readiness checklist: pass, warning, blocked, and exact next command.

Avoid: changing version numbers silently, mixing unrelated fixes, or treating a
local build as permission to publish.
