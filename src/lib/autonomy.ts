/**
 * Permission modes persisted per ShellX tab and applied to agent sessions.
 * Full Auto is the only normal user-facing mode. Legacy values remain in the
 * type so stored tabs and diagnostic API clients can migrate safely.
 */
export type AutonomyMode = "plan" | "acceptEdits" | "default" | "bypassPermissions";
