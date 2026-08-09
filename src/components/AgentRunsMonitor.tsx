import { useEffect, useState, type JSX } from "react";
import {
  getAgentRunsState,
  providerDisplayName,
  type AgentRunManagerState,
  type AgentRunRow,
} from "../lib/provider-sessions";
import { inTauri } from "../lib/tauri-bridge";
import { ShellIcon } from "./icons";

export function AgentRunsMonitor(): JSX.Element {
  const [state, setState] = useState<AgentRunManagerState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshReceipt, setManualRefreshReceipt] = useState({
    sequence: 0,
    generatedAtMs: null as number | null,
  });

  async function refresh(showLoading = true): Promise<void> {
    if (!inTauri()) return;
    if (showLoading) setLoading(true);
    try {
      const next = await getAgentRunsState();
      setState(next);
      setManualRefreshReceipt((current) => ({
        sequence: current.sequence + 1,
        generatedAtMs: next.generatedAtMs,
      }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const tick = async (showLoading = false) => {
      if (!inTauri()) return;
      if (showLoading) setLoading(true);
      try {
        const next = await getAgentRunsState();
        if (cancelled) return;
        setState(next);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled && showLoading) setLoading(false);
      }
    };
    void tick(true);
    const id = window.setInterval(() => void tick(false), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const summary = state?.summary;
  const rows = state?.runs ?? [];
  const visibleRows = rows.slice(0, 7);
  const status = error
    ? { label: "unavailable", className: "warn" }
    : loading && !state
      ? { label: "checking", className: "muted" }
      : summary && summary.runningCount > 0
        ? { label: `${summary.runningCount} running`, className: "ok" }
        : { label: `${summary?.runCount ?? 0} visible`, className: "muted" };
  const nativeNote = state?.nativeSubagents.visibility === "observed"
    ? `${state.nativeSubagents.observedCount} provider-native subagent event${state.nativeSubagents.observedCount === 1 ? "" : "s"} observed.`
    : "Provider-native subagents are shown only when the provider exposes them in the stream.";

  return (
    <section
      className="tasks-agent-runs agent-runs-card"
      data-debug-id="tasks-agent-runs"
      data-agent-runs-manual-refresh-sequence={manualRefreshReceipt.sequence}
      data-agent-runs-manual-refresh-generated-at-ms={manualRefreshReceipt.generatedAtMs ?? ""}
    >
      <div className="tooling-row-top">
        <span className="tooling-name">Agent runs</span>
        <span className={`tooling-status ${status.className}`}>{status.label}</span>
      </div>
      <div className="tooling-detail agent-runs-body">
        {summary && (
          <div className="agent-runs-metrics" aria-label="Agent run counters">
            <span>{summary.tabSessionCount} tabs</span>
            <span>{summary.providerRunCount} provider runs</span>
            <span>{summary.shellxSubagentCount} ShellX subagents</span>
            <span>{summary.observedNativeSubagentCount} native observed</span>
          </div>
        )}
        <div>{nativeNote}</div>
        {visibleRows.length > 0 && (
          <div className="agent-runs-list">
            {visibleRows.map((run) => (
              <AgentRunRowView key={run.id} run={run} />
            ))}
          </div>
        )}
        {!error && !loading && visibleRows.length === 0 && (
          <div className="tooling-issue">No live or recent agent runs reported yet.</div>
        )}
        {error && <div className="tooling-issue">{error}</div>}
      </div>
      <div className="tooling-actions">
        <button
          type="button"
          className="mp-action-btn mp-action-btn-secondary"
          data-debug-id="tasks-agent-runs-refresh"
          data-shellx-release-observe="disabled title"
          title={`Agent runs refresh receipt · sequence=${manualRefreshReceipt.sequence} · generatedAtMs=${manualRefreshReceipt.generatedAtMs ?? "none"}`}
          onClick={() => void refresh()}
          disabled={loading}
        >
          <ShellIcon name="refresh" size={12} />
          Refresh
        </button>
      </div>
    </section>
  );
}

function AgentRunRowView({ run }: { run: AgentRunRow }): JSX.Element {
  const active = run.active || run.status === "running" || run.status === "starting";
  const title = agentRunTitle(run);
  const detail = agentRunDetail(run);
  return (
    <div className={`agent-run-row ${active ? "agent-run-row-active" : ""}`}>
      <span className={`provider-adapter-dot ${active ? "ok" : run.status === "failed" ? "bad" : run.status === "aborted" ? "warn" : "muted"}`} />
      <span className="agent-run-main">
        <strong title={title}>{title}</strong>
        <span title={detail}>{detail}</span>
      </span>
      <span className="agent-run-kind">{formatAgentRunKind(run.kind)}</span>
    </div>
  );
}

function agentRunTitle(run: AgentRunRow): string {
  if (run.kind === "shellx-host-subagent") {
    return `${run.persona ?? "ShellX Agent"}${run.taskPreview ? `: ${run.taskPreview}` : ""}`;
  }
  if (run.kind === "provider-native-subagent") {
    return run.label ?? "Provider-native subagent";
  }
  if (run.kind === "provider-run") {
    return `${run.agentLabel ?? providerLabelFromId(run.providerId)}${run.promptPreview ? `: ${run.promptPreview}` : ""}`;
  }
  return run.title ?? run.agentLabel ?? run.agentId ?? "Session";
}

function agentRunDetail(run: AgentRunRow): string {
  const totalTokens = typeof run.tokens === "object" && run.tokens !== null
    ? run.tokens.totalTokens
    : typeof run.tokens === "number"
      ? run.tokens
      : null;
  const parts = [
    run.status,
    run.surface?.transport ? String(run.surface.transport) : null,
    run.tabId ? `tab ${shortId(run.tabId)}` : null,
    run.runId ? `run ${shortId(run.runId)}` : null,
    run.subagentId ? `subagent ${shortId(run.subagentId)}` : null,
    run.parentSubagentId ? `parent ${shortId(run.parentSubagentId)}` : null,
    run.metrics?.timeToFirstResponseMs != null
      ? `first response ${formatElapsedMs(run.metrics.timeToFirstResponseMs)}`
      : null,
    run.metrics && run.metrics.toolCallCount > 0
      ? `${run.metrics.toolSuccessCount}/${run.metrics.toolCallCount} actions completed`
      : null,
    totalTokens != null ? `${totalTokens.toLocaleString()} tokens` : null,
    run.nativeVisibility === "notExposed" ? "native subagents not exposed" : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

function formatElapsedMs(value: number): string {
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function providerLabelFromId(providerId: AgentRunRow["providerId"]): string {
  if (providerId === "codex-cli" || providerId === "claude-code" || providerId === "antigravity-cli") {
    return providerDisplayName(providerId);
  }
  return typeof providerId === "string" && providerId.trim() ? providerId : "Provider";
}

function formatAgentRunKind(kind: string): string {
  switch (kind) {
    case "tab-session":
      return "tab";
    case "provider-run":
      return "provider";
    case "shellx-host-subagent":
      return "ShellX";
    case "provider-native-subagent":
      return "native";
    default:
      return kind.replace(/-/g, " ");
  }
}

function shortId(value: string): string {
  return value.length > 10 ? `${value.slice(0, 10)}...` : value;
}
