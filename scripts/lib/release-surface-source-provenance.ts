import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export type ReleaseSurfaceGitRunner = (args: string[], cwd: string) => string;

export function assertReleaseSurfaceCollectorSource(input: {
  sourceCommit: string;
  repositoryRoot: string;
  trackedSources: readonly string[];
  runGit?: ReleaseSurfaceGitRunner;
}): void {
  const repositoryRoot = realpathSync(input.repositoryRoot);
  const runGit = input.runGit ?? ((args, cwd) => execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
  const discoveredRoot = realpathSync(runGit(["rev-parse", "--show-toplevel"], repositoryRoot).trim());
  if (discoveredRoot !== repositoryRoot) throw new Error("release evidence collector is not running from its canonical repository root");
  const head = runGit(["rev-parse", "HEAD"], repositoryRoot).trim().toLowerCase();
  if (head !== input.sourceCommit.trim().toLowerCase()) {
    throw new Error(`release evidence collector HEAD ${head} does not match candidate ${input.sourceCommit}`);
  }
  const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"], repositoryRoot).trim();
  if (status) throw new Error(`release evidence collector repository is not clean:\n${status}`);
  const tracked = new Set(runGit(
    ["ls-files", "--error-unmatch", "--", ...input.trackedSources],
    repositoryRoot,
  ).trim().split(/\r?\n/).filter(Boolean));
  for (const source of input.trackedSources) {
    if (!tracked.has(source)) throw new Error(`release evidence collector source is not tracked: ${source}`);
  }
}
