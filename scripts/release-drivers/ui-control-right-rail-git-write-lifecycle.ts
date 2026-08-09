import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  clickReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { nodeReadablePath } from "./debug-api-session-fixture";
import { apiJson, postUi } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type UiState = { activeTab: Record<string, unknown>; rightTab: string };
type WorktreeEntry = { path: string; branch: string | null };

const CHECKPOINT_SURFACE = 'src/components/GitPane.tsx:role=button;name="Checkpoint"';
const WORKTREE_SURFACE = 'src/components/GitPane.tsx:role=button;name="Worktree"';
const CHECKPOINT_CONTROL = ".git-actions > button:nth-child(2)";
const WORKTREE_CONTROL = ".git-actions > button:nth-child(3)";
const OWNED_TRACKED_MARKER = "SHELLX_GIT_WRITE_TRACKED_035";
const OWNED_UNTRACKED_MARKER = "SHELLX_GIT_WRITE_UNTRACKED_035";

export const RIGHT_RAIL_GIT_WRITE_FIXTURES = ["ui:right-rail-git-owned-write-lifecycle"] as const;
export const RIGHT_RAIL_GIT_WRITE_CLEANUPS = [
  "ui:remove-owned-checkpoint-worktree-branch-and-repository-restore-right-rail",
] as const;
export const RIGHT_RAIL_GIT_WRITE_ORACLES = [
  "ui:activation:owned-git-checkpoint-created",
  "ui:activation:owned-git-worktree-created",
] as const;

interface GitWriteFixture {
  nodeRoot: string;
  nodeRepo: string;
  launchRepo: string;
  nodeCheckpointRoot: string;
  checkpointRootExisted: boolean;
  baselineCheckpointDirs: Set<string>;
  baselineWorktrees: WorktreeEntry[];
  baseline: UiState;
  checkpointDir: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
}

export function supportsRightRailGitWriteControl(assignment: Assignment): boolean {
  return assignment.surface.name === CHECKPOINT_SURFACE || assignment.surface.name === WORKTREE_SURFACE;
}

export async function exerciseRightRailGitWriteLifecycle(
  connection: Connection,
  installedInput: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  assignments: Assignment[],
): Promise<ReleaseSurfaceDriverOutcome[]> {
  validateAssignments(assignments);
  const outcomes = new Map(assignments.map((assignment) => [assignment.surface.name, emptyOutcome(assignment)]));
  let fixture: GitWriteFixture | null = null;
  let primaryError: string | null = null;
  try {
    fixture = await prepareFixture(connection, request);
    await postUi(connection, {
      rightTab: "Git",
      activeTabId: fixture.baseline.activeTab.tabId,
      activeTab: { ...fixture.baseline.activeTab, cwd: fixture.launchRepo },
      source: "final-surface-owned-right-rail-git-write",
    });
    await waitForUiState(connection, fixture.baseline.activeTab.tabId, "Git", fixture.launchRepo);

    await exerciseCheckpoint(installedInput, fixture, outcome(outcomes, CHECKPOINT_SURFACE));
    await exerciseWorktree(installedInput, fixture, outcome(outcomes, WORKTREE_SURFACE));
  } catch (error) {
    primaryError = errorText(error);
  } finally {
    const cleanupError = fixture ? await cleanup(connection, fixture) : null;
    for (const value of outcomes.values()) {
      if (!cleanupError) value.cleanup = "pass";
      if (primaryError && !value.error
        && [value.present, value.invoke, value.effect].includes("fail")) value.error = primaryError;
      if (cleanupError) value.error = appendError(value.error, `cleanup: ${cleanupError}`);
      if ([value.present, value.invoke, value.effect, value.cleanup].includes("fail") && !value.error) {
        value.error = "RightRail/GitPane write lifecycle did not satisfy every required verdict";
      }
    }
  }
  return assignments.map((assignment) => outcome(outcomes, assignment.surface.name));
}

async function prepareFixture(
  connection: Connection,
  request: ReleaseSurfaceDriverRequest,
): Promise<GitWriteFixture> {
  const tokenPath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const tokenStat = lstatSync(tokenPath);
  if (tokenStat.isSymbolicLink() || !tokenStat.isFile()
    || basename(tokenPath) !== "shellxagent.token" || basename(dirname(tokenPath)) !== ".shellx") {
    throw new Error("Git write lifecycle requires the installed candidate's regular .shellx token");
  }
  const profileRoot = dirname(dirname(tokenPath));
  const nodeRoot = resolve(profileRoot, "ui-right-rail-git-write-lifecycle");
  const rel = relative(resolve(profileRoot), nodeRoot);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Git write fixture escaped the disposable candidate profile");
  }
  if (existsSync(nodeRoot)) throw new Error("Git write fixture root must not pre-exist");
  const nodeRepo = join(nodeRoot, "repository");
  mkdirSync(nodeRepo, { recursive: true, mode: 0o700 });
  runGit(nodeRepo, ["init", "-b", "release-proof"]);
  runGit(nodeRepo, ["config", "user.name", "ShellX Release Fixture"]);
  runGit(nodeRepo, ["config", "user.email", "shellx-release@example.invalid"]);
  writeFileSync(join(nodeRepo, "README.md"), "# ShellX owned Git fixture\n", { flag: "wx", mode: 0o600 });
  runGit(nodeRepo, ["add", "README.md"]);
  runGit(nodeRepo, ["commit", "-m", "seed owned release fixture"]);
  writeFileSync(join(nodeRepo, "README.md"), `# ShellX owned Git fixture\n${OWNED_TRACKED_MARKER}\n`, { mode: 0o600 });
  writeFileSync(join(nodeRepo, "owned-untracked.txt"), `${OWNED_UNTRACKED_MARKER}\n`, { flag: "wx", mode: 0o600 });

  const launchProfileRoot = portableParent(portableParent(request.runtime.debugTokenPath, request.platform), request.platform);
  const launchRepo = portableJoin(launchProfileRoot, "ui-right-rail-git-write-lifecycle", request.platform)
    + (request.platform === "windows-installed" ? "\\repository" : "/repository");
  const nodeCheckpointRoot = join(profileRoot, ".shellx", "git-checkpoints");
  const baseline = await readUiState(connection);
  if (!baseline.activeTab.tabId || !baseline.rightTab) {
    throw new Error("Git write lifecycle requires a restorable active tab and right rail");
  }
  return {
    nodeRoot,
    nodeRepo,
    launchRepo,
    nodeCheckpointRoot,
    checkpointRootExisted: existsSync(nodeCheckpointRoot),
    baselineCheckpointDirs: checkpointDirs(nodeCheckpointRoot),
    baselineWorktrees: listWorktrees(nodeRepo),
    baseline,
    checkpointDir: null,
    worktreePath: null,
    worktreeBranch: null,
  };
}

async function exerciseCheckpoint(
  installedInput: ReleaseSurfaceInstalledInputSession,
  fixture: GitWriteFixture,
  result: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(
    installedInput,
    CHECKPOINT_CONTROL,
    { timeoutMs: 20_000, pollMs: 100 },
  );
  result.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(installedInput, control);
  result.invoke = "pass";
  const checkpointDir = await waitForOwnedCheckpoint(fixture);
  fixture.checkpointDir = checkpointDir;
  result.effect = "pass";
  result.observedEffect = "Native installed input created one exact ShellX checkpoint for the disposable repository, including tracked diff and untracked snapshot evidence.";
}

async function exerciseWorktree(
  installedInput: ReleaseSurfaceInstalledInputSession,
  fixture: GitWriteFixture,
  result: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(
    installedInput,
    WORKTREE_CONTROL,
    { timeoutMs: 20_000, pollMs: 100 },
  );
  result.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(installedInput, control);
  result.invoke = "pass";
  const created = await waitForOwnedWorktree(fixture);
  fixture.worktreePath = created.path;
  fixture.worktreeBranch = created.branch;
  result.effect = "pass";
  result.observedEffect = "Native installed input created one exact in-repository ShellX worktree and owned branch from the disposable release-proof source branch.";
}

async function waitForOwnedCheckpoint(fixture: GitWriteFixture): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const added = [...checkpointDirs(fixture.nodeCheckpointRoot)]
      .filter((path) => !fixture.baselineCheckpointDirs.has(path));
    if (added.length === 1) {
      validateCheckpoint(added[0]!, fixture);
      return added[0]!;
    }
    if (added.length > 1) throw new Error("Git checkpoint activation created more than one checkpoint directory");
    await delay(100);
  }
  throw new Error("Git checkpoint activation did not create one exact checkpoint directory");
}

function validateCheckpoint(path: string, fixture: GitWriteFixture): void {
  for (const name of ["checkpoint.json", "staged.patch", "status.txt", "unstaged.patch", "untracked.json"]) {
    const target = join(path, name);
    if (!existsSync(target) || lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) {
      throw new Error(`owned Git checkpoint omitted regular ${name}`);
    }
  }
  const metadata = JSON.parse(readFileSync(join(path, "checkpoint.json"), "utf8")) as Record<string, unknown>;
  if (typeof metadata.id !== "string" || !metadata.id
    || typeof metadata.label !== "string" || !metadata.label.startsWith("Before review ")
    || !samePortablePath(String(metadata.repoRoot ?? ""), fixture.launchRepo)
    || metadata.branch !== "release-proof"
    || Number(metadata.unstaged) < 1 || Number(metadata.untracked) < 1) {
    throw new Error("owned Git checkpoint metadata did not match the exact disposable repository state");
  }
  if (!readFileSync(join(path, "unstaged.patch"), "utf8").includes(OWNED_TRACKED_MARKER)
    || !readFileSync(join(path, "untracked.json"), "utf8").includes("owned-untracked.txt")) {
    throw new Error("owned Git checkpoint did not preserve both tracked and untracked fixture evidence");
  }
}

async function waitForOwnedWorktree(fixture: GitWriteFixture): Promise<WorktreeEntry> {
  const baselinePaths = new Set(fixture.baselineWorktrees.map((entry) => nativeCanonicalPathKey(entry.path)));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const added = listWorktrees(fixture.nodeRepo).filter((entry) => !baselinePaths.has(nativeCanonicalPathKey(entry.path)));
    if (added.length === 1) {
      const entry = added[0]!;
      const expectedContainer = resolve(fixture.nodeRepo, ".worktrees");
      if (!nativePathInsideContainer(entry.path, expectedContainer)) {
        throw new Error("owned Git worktree escaped the in-repository .worktrees container");
      }
      if (!entry.branch || !/^refs\/heads\/shellx\/release-proof-\d+$/.test(entry.branch)) {
        throw new Error("owned Git worktree branch did not use the deterministic ShellX branch family");
      }
      if (!existsSync(join(entry.path, "README.md"))
        || !readFileSync(join(entry.path, "README.md"), "utf8").includes("ShellX owned Git fixture")) {
        throw new Error("owned Git worktree did not contain the committed source tree");
      }
      return entry;
    }
    if (added.length > 1) throw new Error("Git worktree activation created more than one worktree");
    await delay(100);
  }
  throw new Error("Git worktree activation did not create one exact worktree");
}

async function cleanup(connection: Connection, fixture: GitWriteFixture): Promise<string | null> {
  const errors: string[] = [];
  try {
    await postUi(connection, {
      rightTab: fixture.baseline.rightTab,
      activeTabId: fixture.baseline.activeTab.tabId,
      activeTab: fixture.baseline.activeTab,
      source: "final-surface-owned-right-rail-git-write-cleanup",
    });
    await waitForUiState(
      connection,
      fixture.baseline.activeTab.tabId,
      fixture.baseline.rightTab,
      String(fixture.baseline.activeTab.cwd ?? ""),
    );
  } catch (error) {
    errors.push(`view restore: ${errorText(error)}`);
  }
  try {
    const added = listWorktrees(fixture.nodeRepo).filter((entry) => (
      !fixture.baselineWorktrees.some((baseline) => (
        nativeCanonicalPathKey(baseline.path) === nativeCanonicalPathKey(entry.path)
      ))
    ));
    for (const entry of added) {
      runGit(fixture.nodeRepo, ["worktree", "remove", "--force", entry.path]);
      if (entry.branch?.startsWith("refs/heads/")) {
        runGit(fixture.nodeRepo, ["branch", "-D", entry.branch.slice("refs/heads/".length)]);
      }
    }
    runGit(fixture.nodeRepo, ["worktree", "prune"]);
    if (listWorktrees(fixture.nodeRepo).length !== fixture.baselineWorktrees.length) {
      throw new Error("owned Git worktree remained after exact cleanup");
    }
  } catch (error) {
    errors.push(`worktree cleanup: ${errorText(error)}`);
  }
  try {
    const added = [...checkpointDirs(fixture.nodeCheckpointRoot)]
      .filter((path) => !fixture.baselineCheckpointDirs.has(path));
    if (added.length > 1) throw new Error("more than one owned checkpoint requires cleanup");
    for (const path of added) {
      rmSync(path, { recursive: true });
      pruneEmptyParents(dirname(path), fixture.nodeCheckpointRoot);
    }
    if (!fixture.checkpointRootExisted) {
      pruneEmptyParents(fixture.nodeCheckpointRoot, dirname(fixture.nodeCheckpointRoot));
    }
    const remaining = [...checkpointDirs(fixture.nodeCheckpointRoot)]
      .filter((path) => !fixture.baselineCheckpointDirs.has(path));
    if (remaining.length > 0) throw new Error("owned Git checkpoint remained after exact cleanup");
  } catch (error) {
    errors.push(`checkpoint cleanup: ${errorText(error)}`);
  }
  try {
    rmSync(fixture.nodeRoot, { recursive: true });
    if (existsSync(fixture.nodeRoot)) throw new Error("owned Git repository root remained");
  } catch (error) {
    errors.push(`repository cleanup: ${errorText(error)}`);
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

function checkpointDirs(root: string): Set<string> {
  const found = new Set<string>();
  if (!existsSync(root)) return found;
  const visit = (dir: string, depth: number): void => {
    if (depth > 5) throw new Error("checkpoint inventory exceeded bounded depth");
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    if (existsSync(join(dir, "checkpoint.json"))) {
      found.add(resolve(dir));
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      visit(join(dir, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

function listWorktrees(repo: string): WorktreeEntry[] {
  const text = runGit(repo, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current) entries.push(current);
  return entries;
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${String(result.stderr || result.stdout).trim().slice(0, 800)}`);
  }
  return String(result.stdout);
}

async function readUiState(connection: Connection): Promise<UiState> {
  const state = await apiJson(connection, "GET", "/state/ui");
  if (!state.activeTab || typeof state.activeTab !== "object" || Array.isArray(state.activeTab)
    || typeof state.rightTab !== "string") {
    throw new Error("Git write lifecycle UI state omitted restorable activeTab or rightTab");
  }
  return { activeTab: structuredClone(state.activeTab as Record<string, unknown>), rightTab: state.rightTab };
}

async function waitForUiState(connection: Connection, tabId: unknown, rightTab: string, cwd: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readUiState(connection);
    if (state.activeTab.tabId === tabId && state.rightTab === rightTab
      && samePortablePath(String(state.activeTab.cwd ?? ""), cwd)) return;
    await delay(50);
  }
  throw new Error("Git write lifecycle did not reach the exact requested UI state");
}

function validateAssignments(assignments: Assignment[]): void {
  if (assignments.length !== 2 || !assignments.some((item) => item.surface.name === CHECKPOINT_SURFACE)
    || !assignments.some((item) => item.surface.name === WORKTREE_SURFACE)) {
    throw new Error("Git write lifecycle requires exactly Checkpoint and Worktree assignments");
  }
  for (const assignment of assignments) {
    if (!supportsRightRailGitWriteControl(assignment)
      || assignment.fixtureId !== RIGHT_RAIL_GIT_WRITE_FIXTURES[0]
      || assignment.cleanupId !== RIGHT_RAIL_GIT_WRITE_CLEANUPS[0]) {
      throw new Error(`Git write assignment does not match ${assignment.surface.name}`);
    }
  }
}

function portableParent(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed") return dirname(path);
  return path.replaceAll("/", "\\").replace(/\\+$/, "").replace(/\\[^\\]+$/, "");
}

function portableJoin(base: string, name: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  return platform === "windows-installed"
    ? `${base.replace(/[\\/]+$/, "")}\\${name}`
    : `${base.replace(/\/+$/, "")}/${name}`;
}

function samePortablePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return /^[A-Za-z]:\//.test(a) || /^[A-Za-z]:\//.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function nativeCanonicalPathKey(path: string): string {
  const canonical = realpathSync.native(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function nativePathInsideContainer(path: string, container: string): boolean {
  const child = nativeCanonicalPathKey(path);
  const parent = nativeCanonicalPathKey(container);
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function pruneEmptyParents(start: string, stop: string): void {
  let current = start;
  const boundary = resolve(stop);
  while (resolve(current).startsWith(`${boundary}${sep}`) && existsSync(current)) {
    if (readdirSync(current).length > 0) return;
    rmdirSync(current);
    current = dirname(current);
  }
}

function emptyOutcome(assignment: Assignment): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No native owned Git write lifecycle effect was observed.",
  };
}

function outcome(map: Map<string, ReleaseSurfaceDriverOutcome>, name: string): ReleaseSurfaceDriverOutcome {
  const value = map.get(name);
  if (!value) throw new Error(`Git write outcome is missing ${name}`);
  return value;
}

function appendError(current: string | undefined, detail: string): string {
  return current ? `${current}; ${detail}` : detail;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
