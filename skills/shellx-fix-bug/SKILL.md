---
name: shellx-fix-bug
description: >
  Use for bug reports, broken builds, failing tests, crashes, incorrect UI
  behavior, or regressions inside a project opened in shellX.
metadata:
  short-description: Reproduce, isolate, patch, and verify a bug
---

# Fix Bug

Work from evidence, not guesses.

1. Reproduce the failure or find the closest failing command/log/test.
2. State the failing symptom in one sentence.
3. Trace from the symptom to the smallest responsible code path.
4. Add or update a focused regression test when practical.
5. Patch the root cause with the smallest safe change.
6. Rerun the focused check, then any broader check the touched area needs.
7. Summarize root cause, files changed, verification, and follow-up risk.

Avoid: timeout inflation without evidence, broad rewrites, deleting user work,
or treating a passing compile as proof of behavior.
