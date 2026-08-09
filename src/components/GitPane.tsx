import { useEffect, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onMouseUpAutoCopy } from "../lib/auto-copy-selection";
import {
  branchNameFromSource,
  gitDirtyTotal,
  gitRepoScopeLabel,
  gitStatusSummary,
  normalizeGitDiffScope,
  type GitCheckpointResponse,
  type GitDiffResponse,
  type GitDiffScope,
  type GitSessionStatus,
  type GitWorktreeResponse,
} from "../lib/git-workflows";
import type { DebugRightRailGitLifecycleFixture } from "../lib/debug-right-rail-git-fixture";
import { inTauri } from "../lib/tauri-bridge";
import { ShellIcon, TransportIcon } from "./icons";
import { ShikiHighlight } from "./ShikiHighlight";

export function GitPane({
  activeTabId,
  cwd,
  debugFixture = null,
}: {
  activeTabId: string | null;
  cwd: string;
  debugFixture?: DebugRightRailGitLifecycleFixture | null;
}): JSX.Element {
  const [status, setStatus] = useState<GitSessionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffScope, setDiffScope] = useState<GitDiffScope>("head");
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [manualRefreshSequence, setManualRefreshSequence] = useState(0);

  const refresh = async (): Promise<void> => {
    if (!activeTabId) return;
    setLoading(true);
    if (debugFixture) {
      setStatus(debugFixture.gitStatus);
      setError(null);
      setManualRefreshSequence((sequence) => sequence + 1);
      setLoading(false);
      return;
    }
    if (!inTauri()) { setLoading(false); return; }
    try {
      const next = await invoke<GitSessionStatus>("git_session_status", {
        cwd: cwd || null,
        tabId: activeTabId,
      });
      setStatus(next);
      setError(null);
      setManualRefreshSequence((sequence) => sequence + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadDiff = async (scopeInput: GitDiffScope): Promise<void> => {
    if (!activeTabId) return;
    const scope = normalizeGitDiffScope(scopeInput);
    setDiffScope(scope);
    setDiffLoading(true);
    if (debugFixture) {
      setDiff(debugFixture.gitDiffs[scope]);
      setDiffLoading(false);
      return;
    }
    if (!inTauri()) { setDiffLoading(false); return; }
    try {
      const next = await invoke<GitDiffResponse>("git_session_diff", {
        cwd: cwd || null,
        tabId: activeTabId,
        scope,
      });
      setDiff(next);
    } catch (e) {
      setDiff({
        ok: false,
        scope,
        repoRoot: status?.repoRoot ?? null,
        branch: status?.branch ?? null,
        diff: "",
        truncated: false,
        bytes: 0,
        lastError: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDiffLoading(false);
    }
  };

  useEffect(() => {
    setStatus(null);
    setDiff(null);
    setError(null);
    setActionMessage(null);
    setManualRefreshSequence(0);
    if (!activeTabId) return;
    if (debugFixture) {
      setStatus(debugFixture.gitStatus);
      setLoading(false);
      return;
    }
    if (!inTauri()) return;
    let cancelled = false;
    const tick = async () => {
      setLoading(true);
      try {
        const next = await invoke<GitSessionStatus>("git_session_status", {
          cwd: cwd || null,
          tabId: activeTabId,
        });
        if (!cancelled) {
          setStatus(next);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 6000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeTabId, cwd, debugFixture]);

  async function createCheckpoint(): Promise<void> {
    if (!activeTabId || debugFixture) return;
    setActionMessage("Creating checkpoint...");
    try {
      const res = await invoke<GitCheckpointResponse>("git_session_create_checkpoint", {
        cwd: cwd || null,
        tabId: activeTabId,
        label: `Before review ${new Date().toLocaleString()}`,
      });
      if (!res.ok || !res.checkpoint) {
        setActionMessage(res.lastError || "Checkpoint failed.");
      } else {
        setActionMessage(`Checkpoint saved: ${res.checkpoint.label}`);
        await refresh();
      }
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : String(e));
    }
  }

  async function createWorktree(): Promise<void> {
    if (!activeTabId || !status?.ok || debugFixture) return;
    const sourceBranch = status.branch || "HEAD";
    const newBranch = branchNameFromSource(sourceBranch);
    setActionMessage(`Creating ${newBranch}...`);
    try {
      const res = await invoke<GitWorktreeResponse>("git_session_create_worktree", {
        cwd: cwd || null,
        tabId: activeTabId,
        sourceBranch,
        newBranch,
      });
      if (!res.ok) {
        setActionMessage(res.lastError || "Worktree creation failed.");
      } else {
        setActionMessage(`Worktree ready: ${res.worktreePath}`);
        await refresh();
      }
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : String(e));
    }
  }

  if (!activeTabId) {
    return (
      <div className="rail-empty">
        <div className="rail-empty-line">No active session.</div>
        <div className="rail-empty-hint">Open or start a tab to inspect repository state.</div>
      </div>
    );
  }

  if (!inTauri() && !debugFixture) {
    return (
      <div className="rail-empty">
        <div className="rail-empty-line">Git checks need Tauri.</div>
        <div className="rail-empty-hint">The desktop backend runs git inside the active tab environment.</div>
      </div>
    );
  }

  const dirtyTotal = status?.ok ? gitDirtyTotal(status) : 0;
  const ready = status?.ok === true;

  return (
    <div className="git-pane">
      <div className="git-head">
        <div>
          <div className="git-title">Session Git</div>
          <div className="git-subtitle">{status ? gitStatusSummary(status) : "Checking repository..."}</div>
        </div>
        <button
          data-debug-id="surface-components-gitpane-1"
          type="button"
          className="mp-action-btn mp-action-btn-secondary"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh repository status"
          title={`Refresh repository status — ${manualRefreshSequence} manual refresh${manualRefreshSequence === 1 ? "" : "es"} completed in this view`}
          data-shellx-release-observe="title"
        >
          <ShellIcon name="refresh" size={12} />
        </button>
      </div>

      {error && (
        <div className="rail-empty tooling-error">
          <div className="rail-empty-line">Git snapshot failed.</div>
          <div className="rail-empty-hint"><code>{error}</code></div>
        </div>
      )}

      {!error && loading && !status && (
        <div className="rail-empty"><div className="rail-empty-line">Checking git...</div></div>
      )}

      {!error && status && !status.ok && (
        <div className="rail-empty">
          <div className="rail-empty-line">No git repository detected.</div>
          <div className="rail-empty-hint"><code>{status.lastError ?? status.cwd}</code></div>
        </div>
      )}

      {ready && status && (
        <>
          <div className="git-card">
            <div className="git-row">
              <span>Repository</span>
              <code title={status.repoRoot ?? status.cwd}>{status.repoName ?? status.repoRoot ?? status.cwd}</code>
            </div>
            <div className="git-row">
              <span>Scope</span>
              <code title={status.repoCwd}>{gitRepoScopeLabel(status)}</code>
            </div>
            <div className="git-row">
              <span>Branch</span>
              <code>{status.branch ?? "detached"}</code>
            </div>
            <div className="git-row">
              <span>Transport</span>
              <span className="git-pill"><TransportIcon value={status.transport} size={12} /> {status.transport}</span>
            </div>
            {status.upstream && (
              <div className="git-row">
                <span>Upstream</span>
                <code>{status.upstream}</code>
              </div>
            )}
          </div>

          <div className="git-metrics" aria-label="Git change counters">
            <GitMetric label="Staged" value={status.staged} tone={status.staged ? "ok" : "muted"} />
            <GitMetric label="Unstaged" value={status.unstaged} tone={status.unstaged ? "warn" : "muted"} />
            <GitMetric label="Untracked" value={status.untracked} tone={status.untracked ? "warn" : "muted"} />
            <GitMetric label="Conflicts" value={status.conflicts} tone={status.conflicts ? "bad" : "muted"} />
          </div>

          <div className="git-actions">
            <button
              type="button"
              className="mp-action-btn mp-action-btn-primary"
              data-shellx-release-control="git-review-diff"
              onClick={() => void loadDiff("head")}
            >
              <ShellIcon name="file" size={12} />
              Review diff
            </button>
            <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={() => void createCheckpoint()} disabled={loading || Boolean(debugFixture)}>
              <ShellIcon name="check" size={12} />
              Checkpoint
            </button>
            <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={() => void createWorktree()} disabled={Boolean(debugFixture)}>
              <ShellIcon name="git-branch" size={12} />
              Worktree
            </button>
          </div>

          {actionMessage && <div className="git-action-message">{actionMessage}</div>}

          <div className="tooling-section-label">Diff review</div>
          <div className="git-diff-tabs" role="tablist" aria-label="Git diff scopes">
            {(["head", "working", "staged", "lastCommit"] as GitDiffScope[]).map((scope) => (
              <button data-debug-id="surface-components-gitpane-5"
                key={scope}
                type="button"
                role="tab"
                aria-selected={diffScope === scope}
                data-shellx-release-observe="selected"
                data-git-diff-scope={scope}
                className={diffScope === scope ? "active" : ""}
                onClick={() => void loadDiff(scope)}
              >
                {scope === "lastCommit" ? "last commit" : scope}
              </button>
            ))}
          </div>
          {diffLoading && <div className="rail-empty"><div className="rail-empty-line">Loading diff...</div></div>}
          {diff && !diffLoading && (
            <div className="git-diff-box" onMouseUp={debugFixture ? undefined : onMouseUpAutoCopy}>
              {!diff.ok && <div className="git-action-message bad">{diff.lastError ?? "Diff failed."}</div>}
              {diff.ok && diff.diff.trim().length === 0 && (
                <div className="rail-empty">
                  <div className="rail-empty-line">No changes in this scope.</div>
                  <div className="rail-empty-hint">{dirtyTotal === 0 ? "The worktree is clean." : "Try another diff scope."}</div>
                </div>
              )}
              {diff.ok && diff.diff.trim().length > 0 && (
                <ShikiHighlight code={diff.diff} path={`session-${diff.scope}.diff`} />
              )}
              {diff.truncated && <div className="git-action-message">Large diff truncated at rail preview limit.</div>}
            </div>
          )}

          <div className="tooling-section-label">Checkpoints</div>
          <div className="git-list">
            {status.checkpoints.length === 0 ? (
              <div className="git-muted">No local shellX checkpoints yet.</div>
            ) : status.checkpoints.slice(0, 5).map((cp) => (
              <div className="git-list-row" key={cp.id} title={cp.path}>
                <span>{cp.label}</span>
                <code>{new Date(cp.createdAtMs).toLocaleString()}</code>
              </div>
            ))}
          </div>

          <div className="tooling-section-label">Worktrees</div>
          <div className="git-list">
            {status.worktrees.length === 0 ? (
              <div className="git-muted">No git worktrees reported.</div>
            ) : status.worktrees.slice(0, 5).map((wt) => (
              <div className="git-list-row" key={wt.path} title={wt.path}>
                <span>{wt.branch ?? (wt.detached ? "detached" : "worktree")}</span>
                <code>{wt.path}</code>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function GitMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "bad" | "muted";
}): JSX.Element {
  return (
    <div className={`git-metric git-metric-${tone}`}>
      <span>{value}</span>
      <small>{label}</small>
    </div>
  );
}
