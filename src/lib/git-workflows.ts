export type GitDiffScope = "head" | "working" | "staged" | "lastCommit";

export interface GitCheckpointSummary {
  id: string;
  label: string;
  createdAtMs: number;
  branch: string | null;
  head: string | null;
  repoRoot: string;
  path: string;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
}

export interface GitWorktreeSummary {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
}

export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
}

export interface GitSessionStatus {
  ok: boolean;
  tabId: string;
  transport: string;
  cwd: string;
  repoRoot: string | null;
  repoName: string | null;
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  head: string | null;
  ahead: number | null;
  behind: number | null;
  clean: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  deleted: number;
  files: GitFileStatus[];
  checkpoints: GitCheckpointSummary[];
  worktrees: GitWorktreeSummary[];
  lastError: string | null;
}

export interface GitDiffResponse {
  ok: boolean;
  scope: GitDiffScope;
  repoRoot: string | null;
  branch: string | null;
  diff: string;
  truncated: boolean;
  bytes: number;
  lastError: string | null;
}

export interface GitCheckpointResponse {
  ok: boolean;
  checkpoint: GitCheckpointSummary | null;
  lastError: string | null;
}

export interface GitWorktreeResponse {
  ok: boolean;
  sourceBranch: string;
  newBranch: string;
  worktreePath: string;
  output: string;
  lastError: string | null;
}

export function sanitizeWorktreeSlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^origin\//, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || "worktree";
}

export function branchNameFromSource(sourceBranch: string, nowMs = Date.now()): string {
  const seconds = Math.floor(nowMs / 1000);
  return `shellx/${sanitizeWorktreeSlug(sourceBranch)}-${seconds}`;
}

export function normalizeGitDiffScope(value: unknown): GitDiffScope {
  if (value === "working" || value === "staged" || value === "lastCommit" || value === "head") {
    return value;
  }
  return "head";
}

export function gitDirtyTotal(status: Pick<GitSessionStatus, "staged" | "unstaged" | "untracked" | "conflicts">): number {
  return status.staged + status.unstaged + status.untracked + status.conflicts;
}

export function gitStatusSummary(status: GitSessionStatus): string {
  if (!status.ok) return status.lastError || "Git status unavailable";
  const parts: string[] = [];
  parts.push(status.branch || "detached");
  if (status.ahead) parts.push(`${status.ahead} ahead`);
  if (status.behind) parts.push(`${status.behind} behind`);
  const dirty = gitDirtyTotal(status);
  parts.push(dirty === 0 ? "clean" : `${dirty} changes`);
  return parts.join(" · ");
}
