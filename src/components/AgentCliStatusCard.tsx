import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  providerExecutionTargetLabel,
  providerDisplayName,
  type ProviderExecutionTransport,
  type ProviderId,
} from "../lib/provider-sessions";
import {
  connectionProviderScanRequestKey,
  CONNECTION_PROVIDER_CAPABILITY_TTL_MS,
  providerScanStatus,
  scanConnectionProviderCapabilities,
} from "../lib/connection-provider-capabilities";
import { AgentCliSetupDialog } from "./AgentCliSetupAssistant";
import type { AgentCliSetupFixture } from "./AgentCliSetupAssistant";
import { setupStateToProviderScan } from "../lib/agent-cli-setup";
import type {
  ConnectionPreset,
  ConnectionProviderCapabilitySnapshot,
  ConnectionProviderScanEntry,
} from "./ConnectionPicker";
import { ShellIcon } from "./icons";

type AgentCliId = "grok" | ProviderId;

const AGENT_CLI_IDS: AgentCliId[] = ["grok", "claude-code", "codex-cli", "antigravity-cli"];

interface AgentCliLiveInventory {
  requestKey: string;
  providers: ConnectionProviderScanEntry[];
  capability: ConnectionProviderCapabilitySnapshot | null;
}

export interface AgentCliSessionInfo {
  transport?: string;
  wslDistro?: string | null;
  sshHost?: string | null;
  sshPort?: number | null;
  sshKeyVaultRef?: string | null;
  hasActiveChild?: boolean;
  hasActiveProviderChild?: boolean;
  hasProviderContext?: boolean;
}

export function AgentCliStatusCard({
  activeTabId,
  sessionInfo,
  connectionId,
  connectionTransport,
  connectionPreset,
  onProviderScanUpdated,
  fixture,
}: {
  activeTabId: string | null;
  sessionInfo: AgentCliSessionInfo | null;
  connectionId: string | null;
  connectionTransport: string;
  connectionPreset: ConnectionPreset | null;
  onProviderScanUpdated?: (preset: ConnectionPreset, providers: ConnectionProviderScanEntry[]) => void;
  fixture?: AgentCliSetupFixture;
}): JSX.Element {
  const [inventory, setInventory] = useState<AgentCliLiveInventory | null>(null);
  const [loadingRequestKey, setLoadingRequestKey] = useState<string | null>(null);
  const [scanError, setScanError] = useState<{ requestKey: string; message: string } | null>(null);
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [setupProviderId, setSetupProviderId] = useState<AgentCliId | null>(null);
  const requestGenerationRef = useRef(0);
  const freshnessRef = useRef<{ requestKey: string; freshUntilMs: number } | null>(null);
  const providerExecution = providerExecutionForSession(
    sessionInfo,
    connectionTransport,
    connectionPreset,
  );
  const waitingForSavedPreset = Boolean(connectionId && connectionPreset?.id !== connectionId);
  const scanPreset = waitingForSavedPreset
    ? null
    : agentScanPresetForSession(connectionPreset, providerExecution);
  const scanRequestKey = scanPreset ? connectionProviderScanRequestKey(scanPreset) : null;
  const currentPresetRef = useRef(scanPreset);
  currentPresetRef.current = scanPreset;
  const currentRequestKeyRef = useRef(scanRequestKey);
  currentRequestKeyRef.current = scanRequestKey;
  const onProviderScanUpdatedRef = useRef(onProviderScanUpdated);
  onProviderScanUpdatedRef.current = onProviderScanUpdated;
  const fixtureProviders = fixture ? setupStateToProviderScan(fixture.state) : null;
  const inventoryMatchesTarget = Boolean(scanRequestKey && inventory?.requestKey === scanRequestKey);
  const agentScan = fixtureProviders ?? (inventoryMatchesTarget ? inventory?.providers ?? [] : []);
  const capabilitySnapshot = fixture ? null : inventoryMatchesTarget ? inventory?.capability ?? null : null;
  const message = fixture ? null : scanRequestKey && scanError?.requestKey === scanRequestKey ? scanError.message : null;
  const loading = !fixture && Boolean(
    activeTabId && (
      waitingForSavedPreset || (
        scanRequestKey && (
          loadingRequestKey === scanRequestKey || (!inventoryMatchesTarget && !message)
        )
      )
    )
  );

  const refreshProviderEnvironment = useCallback(async (): Promise<void> => {
    if (fixture) return;
    const preset = currentPresetRef.current;
    const requestKey = currentRequestKeyRef.current;
    if (!activeTabId || !preset || !requestKey) {
      requestGenerationRef.current += 1;
      setLoadingRequestKey(null);
      setInventory(null);
      return;
    }
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    setLoadingRequestKey(requestKey);
    setScanError(null);
    try {
      const snapshot = await scanConnectionProviderCapabilities(preset);
      if (
        requestGenerationRef.current !== generation ||
        currentRequestKeyRef.current !== requestKey
      ) return;
      freshnessRef.current = { requestKey, freshUntilMs: snapshot.freshUntilMs };
      setInventory({ requestKey, providers: snapshot.providers, capability: snapshot });
      onProviderScanUpdatedRef.current?.(preset, snapshot.providers);
    } catch (e) {
      if (
        requestGenerationRef.current === generation &&
        currentRequestKeyRef.current === requestKey
      ) {
        setInventory(null);
        setScanError({ requestKey, message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      if (
        requestGenerationRef.current === generation &&
        currentRequestKeyRef.current === requestKey
      ) setLoadingRequestKey(null);
    }
  }, [activeTabId, fixture, scanRequestKey]);

  useEffect(() => {
    if (fixture) return;
    if (!activeTabId || !scanRequestKey) return;
    void refreshProviderEnvironment();
    const refreshWhenVisibleAndStale = () => {
      if (document.visibilityState === "hidden") return;
      const freshness = freshnessRef.current;
      if (
        freshness?.requestKey === scanRequestKey &&
        Date.now() < freshness.freshUntilMs
      ) return;
      void refreshProviderEnvironment();
    };
    window.addEventListener("focus", refreshWhenVisibleAndStale);
    document.addEventListener("visibilitychange", refreshWhenVisibleAndStale);
    return () => {
      requestGenerationRef.current += 1;
      window.removeEventListener("focus", refreshWhenVisibleAndStale);
      document.removeEventListener("visibilitychange", refreshWhenVisibleAndStale);
    };
  }, [activeTabId, fixture, refreshProviderEnvironment, scanRequestKey]);

  useEffect(() => {
    if (fixture) return;
    setSetupDialogOpen(false);
    setSetupProviderId(null);
  }, [fixture]);

  const readyCount = AGENT_CLI_IDS.filter((id) => {
    const scan = agentScan.find((item) => item.providerId === id);
    return scan ? providerScanStatus(scan) === "ready" : false;
  }).length;
  const cardStatus = loading
    ? { label: "checking", className: "muted" }
    : message
      ? { label: "unavailable", className: "warn" }
      : readyCount === AGENT_CLI_IDS.length
        ? { label: `${readyCount}/${AGENT_CLI_IDS.length} ready`, className: "ok" }
        : readyCount > 0
          ? { label: `${readyCount}/${AGENT_CLI_IDS.length} ready`, className: "warn" }
          : { label: "missing", className: "warn" };
  const providerTargetLabel = capabilitySnapshot?.target.label ?? (
    providerExecution.unsupportedTransport
      ? providerExecution.unsupportedTransport.toUpperCase()
      : providerExecutionTargetLabel(providerExecution)
  );
  const providerTargetHint = providerExecution.unsupportedTransport
    ? " - agent CLI checks support local, WSL, and SSH targets"
    : providerExecution.transport === "wsl" && !providerExecution.wslDistro
      ? " - reconnect WSL tab to resolve distro"
      : providerExecution.transport === "ssh" && !providerExecution.sshHost
        ? " - reconnect SSH tab to resolve host"
        : "";
  const setupPreset = scanPreset;
  const setupMissingProviderId = !loading && !message && setupPreset && agentScan.length > 0
    ? AGENT_CLI_IDS.find((id) => agentCliNeedsSetup(id, agentScan)) ?? null
    : null;

  return (
    <div className="tooling-row provider-runner">
      <div className="tooling-row-top">
        <span className="tooling-name">Agent CLIs</span>
        <span className={`tooling-status ${cardStatus.className}`}>{cardStatus.label}</span>
      </div>
      <div className="tooling-detail provider-runner-body">
        <div>
          Target:{" "}
          <code>{providerTargetLabel}</code>
          {providerTargetHint}
        </div>
        {capabilitySnapshot && (
          <div>
            Inventory: <code>{capabilitySnapshot.target.runtime}</code>
            {" - checked "}{new Date(capabilitySnapshot.generatedAtMs).toLocaleTimeString()}
          </div>
        )}
        <div className="provider-adapter-list">
          {AGENT_CLI_IDS.map((id) => {
            const scan = agentScan.find((item) => item.providerId === id);
            const status = agentCliStatus(scan, loading);
            return (
              <div
                key={id}
                className="provider-adapter-row"
                data-agent-cli-provider={id}
                data-shellx-release-observe="title"
                title={agentCliScanReceipt(scan, loading)}
              >
                <span className={`provider-adapter-dot ${status.className}`} />
                <span className="provider-adapter-main">
                  <strong>{agentCliDisplayName(id)}</strong>
                  <span>{agentCliDetail(id, scan, loading)}</span>
                </span>
                {scan && agentCliNeedsSetup(id, agentScan) && setupPreset && (
                  <button
                    type="button"
                    className="provider-adapter-setup"
                    data-debug-id={`agent-cli-setup-open-${id}`}
                    onClick={() => {
                      setSetupProviderId(id);
                      setSetupDialogOpen(true);
                    }}
                  >
                    Set up
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {setupDialogOpen && setupPreset && (
          <AgentCliSetupDialog
            preset={setupPreset}
            initialProviderId={setupProviderId ?? undefined}
            missingOnly={!setupProviderId}
            fixture={fixture}
            onClose={() => {
              setSetupDialogOpen(false);
              setSetupProviderId(null);
            }}
            onSetupChanged={(providers) => {
              const requestKey = currentRequestKeyRef.current;
              if (requestKey) {
                const checkedAtMs = Math.max(0, ...providers.map((provider) => provider.checkedAtMs));
                freshnessRef.current = {
                  requestKey,
                  freshUntilMs: checkedAtMs + CONNECTION_PROVIDER_CAPABILITY_TTL_MS,
                };
                setInventory({ requestKey, providers, capability: null });
              }
              onProviderScanUpdated?.(setupPreset, providers);
            }}
          />
        )}
        {message && <div className="tooling-issue">{message}</div>}
      </div>
      <div className="tooling-actions provider-runner-actions">
        {setupMissingProviderId && (
          <button
            type="button"
            className="mp-action-btn mp-action-btn-secondary"
            data-debug-id="agent-cli-setup-open-missing"
            onClick={() => {
              setSetupProviderId(null);
              setSetupDialogOpen(true);
            }}
          >
            <ShellIcon name="plus" size={12} />
            Set up
          </button>
        )}
        <button
          type="button"
          className="mp-action-btn mp-action-btn-secondary"
          onClick={() => void refreshProviderEnvironment()}
          disabled={!activeTabId || loading}
        >
          <ShellIcon name="refresh" size={12} />
          Refresh
        </button>
      </div>
    </div>
  );
}

function providerExecutionForSession(
  sessionInfo: AgentCliSessionInfo | null,
  connectionTransport: string,
  connectionPreset: ConnectionPreset | null,
): {
  transport: ProviderExecutionTransport;
  wslDistro: string | null;
  sshHost: string | null;
  sshPort?: number;
  sshKeyVaultRef: string | null;
  sshRemoteRuntime?: "posix" | "windows" | "windows_wsl";
  sshWslDistro?: string | null;
  unsupportedTransport: string | null;
} {
  const hasSessionContext =
    sessionInfo?.hasActiveChild === true ||
    sessionInfo?.hasActiveProviderChild === true ||
    sessionInfo?.hasProviderContext === true;
  if (sessionInfo?.transport === "wsl" && hasSessionContext) {
    const distro = typeof sessionInfo.wslDistro === "string" && sessionInfo.wslDistro.trim()
      ? sessionInfo.wslDistro.trim()
      : null;
    return { transport: "wsl", wslDistro: distro, sshHost: null, sshKeyVaultRef: null, unsupportedTransport: null };
  }
  if (sessionInfo?.transport === "ssh" && hasSessionContext) {
    const host = typeof sessionInfo.sshHost === "string" && sessionInfo.sshHost.trim()
      ? sessionInfo.sshHost.trim()
      : connectionPreset?.transport.kind === "ssh"
        ? connectionPreset.transport.host.trim()
        : null;
    return {
      transport: "ssh",
      wslDistro: null,
      sshHost: host,
      sshPort: typeof sessionInfo.sshPort === "number"
        ? sessionInfo.sshPort
        : connectionPreset?.transport.kind === "ssh"
          ? connectionPreset.transport.port
          : undefined,
      sshKeyVaultRef: typeof sessionInfo.sshKeyVaultRef === "string" && sessionInfo.sshKeyVaultRef.trim()
        ? sessionInfo.sshKeyVaultRef.trim()
        : connectionPreset?.transport.kind === "ssh"
          ? connectionPreset.transport.keyVaultRef ?? null
          : null,
      sshRemoteRuntime: connectionPreset?.transport.kind === "ssh"
        ? connectionPreset.transport.remoteRuntime ?? "posix"
        : "posix",
      sshWslDistro: connectionPreset?.transport.kind === "ssh"
        ? connectionPreset.transport.wslDistro ?? null
        : null,
      unsupportedTransport: null,
    };
  }
  if (sessionInfo?.transport === "local" && hasSessionContext) {
    return { transport: "local", wslDistro: null, sshHost: null, sshKeyVaultRef: null, unsupportedTransport: null };
  }
  if (
    sessionInfo?.hasActiveChild &&
    sessionInfo.transport &&
    !["none", "local", "ssh"].includes(sessionInfo.transport)
  ) {
    return { transport: "local", wslDistro: null, sshHost: null, sshKeyVaultRef: null, unsupportedTransport: sessionInfo.transport };
  }
  if (connectionPreset?.transport.kind === "wsl") {
    return {
      transport: "wsl",
      wslDistro: connectionPreset.transport.distro?.trim() || null,
      sshHost: null,
      sshKeyVaultRef: null,
      unsupportedTransport: null,
    };
  }
  if (connectionPreset?.transport.kind === "ssh") {
    return {
      transport: "ssh",
      wslDistro: null,
      sshHost: connectionPreset.transport.host?.trim() || null,
      sshPort: connectionPreset.transport.port,
      sshKeyVaultRef: connectionPreset.transport.keyVaultRef ?? null,
      sshRemoteRuntime: connectionPreset.transport.remoteRuntime ?? "posix",
      sshWslDistro: connectionPreset.transport.wslDistro ?? null,
      unsupportedTransport: null,
    };
  }
  if (connectionPreset?.transport.kind && connectionPreset.transport.kind !== "local") {
    return {
      transport: "local",
      wslDistro: null,
      sshHost: null,
      sshKeyVaultRef: null,
      unsupportedTransport: connectionPreset.transport.kind,
    };
  }
  if (connectionTransport === "wsl") {
    return { transport: "wsl", wslDistro: null, sshHost: null, sshKeyVaultRef: null, unsupportedTransport: null };
  }
  if (connectionTransport === "ssh") {
    return { transport: "ssh", wslDistro: null, sshHost: null, sshKeyVaultRef: null, unsupportedTransport: null };
  }
  if (connectionTransport && connectionTransport !== "local") {
    return { transport: "local", wslDistro: null, sshHost: null, sshKeyVaultRef: null, unsupportedTransport: connectionTransport };
  }
  return { transport: "local", wslDistro: null, sshHost: null, sshKeyVaultRef: null, unsupportedTransport: null };
}

function agentScanPresetForSession(
  connectionPreset: ConnectionPreset | null,
  execution: {
    transport: ProviderExecutionTransport;
    wslDistro: string | null;
    sshHost: string | null;
    sshPort?: number;
    sshKeyVaultRef: string | null;
    sshRemoteRuntime?: "posix" | "windows" | "windows_wsl";
    sshWslDistro?: string | null;
    unsupportedTransport: string | null;
  },
): ConnectionPreset | null {
  if (connectionPreset && ["local", "wsl", "ssh"].includes(connectionPreset.transport.kind)) {
    return connectionPreset;
  }
  if (execution.unsupportedTransport) return null;
  if (execution.transport === "local") {
    return {
      id: "",
      label: "Current local",
      transport: { kind: "local" },
      createdMs: 0,
      lastUsedMs: 0,
    };
  }
  if (execution.transport === "wsl" && execution.wslDistro) {
    return {
      id: "",
      label: `WSL ${execution.wslDistro}`,
      transport: { kind: "wsl", distro: execution.wslDistro, grokPath: "" },
      createdMs: 0,
      lastUsedMs: 0,
    };
  }
  if (execution.transport === "ssh" && execution.sshHost) {
    return {
      id: "",
      label: `SSH ${execution.sshHost}`,
      transport: {
        kind: "ssh",
        host: execution.sshHost,
        port: execution.sshPort,
        keyVaultRef: execution.sshKeyVaultRef ?? undefined,
        remoteGrokPath: "grok",
        remoteRuntime: execution.sshRemoteRuntime ?? "posix",
        wslDistro: execution.sshWslDistro ?? undefined,
      },
      createdMs: 0,
      lastUsedMs: 0,
    };
  }
  return null;
}

function agentCliNeedsSetup(
  id: AgentCliId,
  scan: ConnectionProviderScanEntry[],
): boolean {
  const scanned = scan.find((item) => item.providerId === id);
  return scanned ? providerScanStatus(scanned) === "missing" : false;
}

function agentCliDisplayName(id: AgentCliId): string {
  if (id === "grok") return "Grok Build CLI";
  return providerDisplayName(id);
}

function agentCliStatus(
  scan: ConnectionProviderScanEntry | undefined,
  loading: boolean,
): { label: string; className: string } {
  if (loading) return { label: "checking", className: "muted" };
  if (!scan) return { label: "not scanned", className: "muted" };
  switch (providerScanStatus(scan)) {
    case "ready":
      return { label: "ready", className: "ok" };
    case "missing":
      return { label: "missing", className: "warn" };
    case "versionFailed":
      return { label: "version failed", className: "warn" };
    case "identityFailed":
      return { label: "identity failed", className: "warn" };
    case "authNeeded":
      return { label: "auth needed", className: "warn" };
    case "targetUnavailable":
      return { label: "unavailable", className: "warn" };
    case "canaryFailed":
      return { label: "check failed", className: "warn" };
    default:
      return { label: "unknown", className: "muted" };
  }
}

function agentCliDetail(
  id: AgentCliId,
  scan: ConnectionProviderScanEntry | undefined,
  loading: boolean,
): string {
  if (loading) return "checking live version";
  if (scan) {
    const stream = id === "grok" ? "" : ` - ${providerStreamKind(id)} stream`;
    const detail = scan.detail ?? (() => {
      switch (providerScanStatus(scan)) {
        case "ready": return scan.version ?? scan.binary ?? "ready";
        case "missing": return "missing CLI";
        case "versionFailed": return "CLI found; version check failed";
        case "identityFailed": return "CLI version passed; executable identity check failed";
        case "authNeeded": return "target authentication required";
        case "targetUnavailable": return "target unavailable";
        case "canaryFailed": return "provider canary failed";
        default: return "scan status unknown";
      }
    })();
    return `${detail}${stream}`;
  }
  return "not scanned";
}

function providerStreamKind(id: ProviderId): "jsonl" | "stream-json" {
  return id === "codex-cli" ? "jsonl" : "stream-json";
}

function agentCliScanReceipt(
  scan: ConnectionProviderScanEntry | undefined,
  loading: boolean,
): string {
  const detail = loading
    ? "checking"
    : scan?.version
      ? `version ${scan.version}`
      : `status ${scan ? providerScanStatus(scan) : "not-scanned"}`;
  return `Agent CLI scan receipt: ${detail}`.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200);
}
