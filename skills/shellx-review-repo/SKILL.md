---
name: shellx-review-repo
description: >
  Use when the user asks to understand, audit, review, clean up, or plan work
  for a repository opened in shellX.
metadata:
  short-description: Map a repo, find risks, and propose useful next work
---

# Review Repo

Give the user a useful map and the highest-value next steps.

1. Read the README, package/build files, tests, and top-level structure.
2. Identify the app type, main entry points, data/storage boundaries, and run commands.
3. Check git status before judging files. Treat dirty work as user-owned unless told otherwise.
4. Look for concrete risks: broken scripts, missing tests around critical paths,
   unsafe file/network/secret handling, stale generated files, and unclear release flow.
5. Run an AI slop / wiring pass: unwired UI controls, placeholder/mock/demo
   code, fake success states, frontend calls with no backend bridge, backend
   commands with no UI/code path, schema/config name drift, and release-debug
   leaks.
6. Keep findings actionable with file references and severity.
7. End with a short roadmap: quick wins, medium fixes, bigger bets.

Avoid: generic best-practice lists, speculative rewrites, and dumping every file
name instead of explaining the system.
