import {
  branchNameFromSource,
  gitStatusSummary,
  normalizeGitDiffScope,
  sanitizeWorktreeSlug,
  type GitSessionStatus,
} from "../src/lib/git-workflows";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== git workflow helpers ===");

assert(sanitizeWorktreeSlug("feature/Activity Graph!") === "feature-activity-graph", "worktree slug strips unsafe branch text");
assert(sanitizeWorktreeSlug("///") === "worktree", "empty sanitized branch falls back");
assert(branchNameFromSource("origin/main", 1779583000000) === "shellx/main-1779583000", "remote branch creates shellx local branch name");
assert(branchNameFromSource("feature/demo", 1779583000000) === "shellx/feature-demo-1779583000", "local source branch gets timestamped shellx branch");
assert(normalizeGitDiffScope("staged") === "staged", "staged diff scope is accepted");
assert(normalizeGitDiffScope("unknown") === "head", "unknown diff scope falls back to full HEAD diff");

const status: GitSessionStatus = {
  ok: true,
  tabId: "tab-1",
  transport: "ssh",
  cwd: "/srv/app",
  repoRoot: "/srv/app",
  repoName: "app",
  branch: "feature/activity",
  upstream: "origin/feature/activity",
  remote: "git@github.com:example/app.git",
  head: "abc1234",
  ahead: 2,
  behind: 1,
  clean: false,
  staged: 1,
  unstaged: 2,
  untracked: 3,
  conflicts: 1,
  deleted: 1,
  files: [],
  checkpoints: [],
  worktrees: [],
  lastError: null,
};
const summary = gitStatusSummary(status);
assert(summary.includes("feature/activity"), "summary includes branch");
assert(summary.includes("2 ahead"), "summary includes ahead count");
assert(summary.includes("1 behind"), "summary includes behind count");
assert(summary.includes("7 changes"), "summary includes dirty total");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} git workflow helper tests`);
process.exit(failures === 0 ? 0 : 1);
