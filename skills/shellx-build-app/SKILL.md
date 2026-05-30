---
name: shellx-build-app
description: >
  Use for casual app-building requests in shellX: create or extend a web,
  desktop, CLI, or small service project from an idea, then run and verify it.
metadata:
  short-description: Build a working app with focused planning and verification
---

# Build App

Turn the request into a working result without overbuilding.

1. Identify the stack and existing run/test commands. If the project is empty,
   choose the smallest mainstream stack that fits the ask.
2. Ask one question only if a missing product choice would change the build.
3. Make a short task list: scaffold, core behavior, UI/IO, verification.
4. Implement in small slices. Prefer existing project patterns and dependencies.
5. For UI work, ship the actual usable screen first; avoid marketing pages unless asked.
6. For web/app UI, start shellX Work Preview with `preview_start`, preferring
   `shellx-host-http__preview_start` when that prefix is advertised, then
   diagnose it with `preview_diagnose`. Static HTML can preview directly.
   Node apps need dependencies installed first; Expo web also needs
   `react-dom` and `react-native-web` installed through
   `npx expo install react-dom react-native-web`.
7. Run the app or focused tests. For visual UI, use Preview Doctor and inspect
   a screenshot when possible.
8. Report changed files, commands run, and any remaining risk.

Avoid: large framework swaps, decorative UI, fake TODO buttons, and claiming done
without verification output.
