import type {
  GitDiffResponse,
  GitDiffScope,
  GitSessionStatus,
} from "./git-workflows";
import type { ModelInstructionCardsState } from "./model-instruction-cards";

export const DEBUG_RIGHT_RAIL_GIT_LIFECYCLE_FIXTURE = "right-rail-git-lifecycle";

export interface DebugRightRailGitLifecycleFixture {
  fixtureOnly: true;
  gitStatus: GitSessionStatus;
  gitDiffs: Record<GitDiffScope, GitDiffResponse>;
  modelInstructionCards: ModelInstructionCardsState;
  environmentSnapshot: Record<string, unknown>;
}

/**
 * Resolve the fixed RightRail/GitPane read fixture used by the installed UI
 * driver. It is renderer-only: no repository, updater, provider, clipboard,
 * trace, filesystem, or network operation is performed.
 */
export function debugRightRailGitLifecycleFixture(
  command: unknown,
  tabId: string,
): DebugRightRailGitLifecycleFixture | null | undefined {
  if (!command || typeof command !== "object" || Array.isArray(command)) return undefined;
  const body = command as Record<string, unknown>;
  if (body.id !== DEBUG_RIGHT_RAIL_GIT_LIFECYCLE_FIXTURE) return undefined;
  if (body.action === "clear") return null;

  const repoRoot = "release-owned-renderer-fixture";
  const branch = "shellx/release-owned-read-only";
  const gitStatus: GitSessionStatus = {
    ok: true,
    tabId,
    transport: "local",
    cwd: repoRoot,
    repoCwd: repoRoot,
    repoScope: "cwd",
    repoCandidates: [],
    repoRoot,
    repoName: "release-owned-renderer-fixture",
    branch,
    upstream: null,
    remote: null,
    head: "0350350350350350350350350350350350350350",
    ahead: null,
    behind: null,
    clean: false,
    staged: 1,
    unstaged: 1,
    untracked: 0,
    conflicts: 0,
    deleted: 0,
    files: [
      { path: "owned-readme.md", index: "M", worktree: " " },
      { path: "owned-plan.md", index: " ", worktree: "M" },
    ],
    checkpoints: [],
    worktrees: [],
    lastError: null,
  };
  const gitDiffs = Object.fromEntries(
    (["head", "working", "staged", "lastCommit"] as const).map((scope) => {
      const label = scope === "lastCommit" ? "last commit" : scope;
      const diff = [
        "diff --git a/owned-readme.md b/owned-readme.md",
        "--- a/owned-readme.md",
        "+++ b/owned-readme.md",
        "@@ -1 +1 @@",
        `-owned ${label} baseline`,
        `+owned ${label} refreshed`,
        "",
      ].join("\n");
      const response: GitDiffResponse = {
        ok: true,
        scope,
        repoRoot,
        branch,
        diff,
        truncated: false,
        bytes: diff.length,
        lastError: null,
      };
      return [scope, response];
    }),
  ) as Record<GitDiffScope, GitDiffResponse>;

  const modelInstructionCards: ModelInstructionCardsState = {
    version: "release-owned-renderer-fixture",
    lastReviewed: "2026-07-31",
    policy: {
      shellxMayAutoRoute: false,
      defaultRouteMode: "explicitOnly",
      defaultToolExposureMode: "nativeFirst",
      toolExposureModes: [],
      fallbackRule: "Use only the explicitly selected provider.",
      operatorRule: "The operator chooses every provider handoff.",
    },
    cards: [],
  };

  const environmentSnapshot: Record<string, unknown> = {
    tabId,
    status: "pass",
    checkedAtMs: 1_750_000_000_000,
    transport: "local",
    cwd: "release-owned-renderer-fixture",
    sessionId: "release-owned-environment-session",
    doctor: {
      summary: { status: "pass", healthyCount: 1, failingCount: 0, totalCount: 1 },
      servers: [{
        name: "owned-fixture-mcp",
        transport: "stdio",
        target: "owned-fixture",
        source: "renderer-fixture",
        healthy: true,
        category: "healthy",
      }],
    },
    inspect: {
      grokVersion: "fixture-0.3.5",
      projectTrusted: true,
      instructionCount: 1,
      skillCount: 1,
      pluginCount: 0,
      mcpServerCount: 1,
      lspServerCount: 0,
    },
    setup: { summary: { status: "pass", readyCount: 1, attentionCount: 0, totalCount: 1 }, checks: [] },
    readiness: { summary: { status: "pass", readyCount: 1, attentionCount: 0, totalCount: 1 }, checks: [] },
    apiKeyHint: {
      preferredEnv: "XAI_API_KEY",
      legacyEnv: "GROK_API_KEY",
      preferredPresent: true,
      legacyPresent: false,
      detail: "Owned fixture only.",
    },
    trace: {
      available: true,
      sessionId: "release-owned-environment-session",
      detail: "Owned fixture trace export stops before filesystem access.",
    },
    error: null,
  };

  return { fixtureOnly: true, gitStatus, gitDiffs, modelInstructionCards, environmentSnapshot };
}
