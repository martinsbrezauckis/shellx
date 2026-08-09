import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentId } from "../lib/agent-selection";
import {
  cancelAgentCliInstall,
  confirmAgentCliInstall,
  getAgentCliSetupState,
  prepareAgentCliInstall,
  recheckAgentCliSetup,
  setupStateToProviderScan,
  type AgentCliInstallConfirmation,
  type AgentCliInstallResult,
  type AgentCliSetupCard,
  type AgentCliSetupState,
} from "../lib/agent-cli-setup";
import type { ConnectionPreset, ConnectionProviderScanEntry } from "./ConnectionPicker";
import { useModalFocus } from "../lib/useModalFocus";

export interface AgentCliSetupFixture {
  state: AgentCliSetupState;
  confirmation?: AgentCliInstallConfirmation | null;
  allowOwnedClipboard?: boolean;
  allowOwnedExternal?: boolean;
  allowOwnedInstall?: boolean;
}

export function AgentCliSetupAssistant({
  preset,
  initialProviderId,
  onSetupChanged,
  onClose,
  embedded = false,
  missingOnly = false,
  fixture,
}: {
  preset: ConnectionPreset | null;
  initialProviderId?: AgentId | string | null;
  onSetupChanged?: (providers: ConnectionProviderScanEntry[]) => void;
  onClose?: () => void;
  embedded?: boolean;
  missingOnly?: boolean;
  fixture?: AgentCliSetupFixture;
}): JSX.Element | null {
  const [state, setState] = useState<AgentCliSetupState | null>(() => fixture?.state ?? null);
  const [loading, setLoading] = useState(false);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<AgentCliInstallConfirmation | null>(
    () => fixture?.confirmation ?? null,
  );
  const [installResult, setInstallResult] = useState<AgentCliInstallResult | null>(null);
  const confirmationRef = useRef<HTMLDivElement | null>(null);
  const closeConfirmationFromKeyboard = useCallback(() => {
    if (!confirmation || fixture) return;
    const confirmationId = confirmation.confirmationId;
    setConfirmation(null);
    void cancelAgentCliInstall(confirmationId).catch(() => { /* expiry cleanup remains as fallback */ });
  }, [confirmation, fixture]);
  useModalFocus(Boolean(confirmation), confirmationRef, closeConfirmationFromKeyboard);
  const presetKey = useMemo(
    () => preset ? `${preset.id}|${preset.label}|${JSON.stringify(preset.transport)}` : "",
    [preset],
  );

  useEffect(() => {
    if (!preset) {
      setState(null);
      setError(null);
      return;
    }
    if (fixture) {
      setState(fixture.state);
      setConfirmation(fixture.confirmation ?? null);
      setLoading(false);
      setBusyProviderId(null);
      setError(null);
      setInstallResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getAgentCliSetupState(preset)
      .then((next) => {
        if (cancelled) return;
        setState(next);
        onSetupChanged?.(setupStateToProviderScan(next));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fixture, presetKey]);

  useEffect(() => {
    const confirmationId = confirmation?.confirmationId;
    if (!confirmationId || fixture?.confirmation?.confirmationId === confirmationId) return;
    return () => {
      void cancelAgentCliInstall(confirmationId).catch(() => { /* expiry cleanup remains as fallback */ });
    };
  }, [confirmation?.confirmationId, fixture?.confirmation?.confirmationId]);

  const providers = useMemo(() => {
    const all = state?.providers ?? [];
    if (initialProviderId) return all.filter((provider) => provider.providerId === initialProviderId);
    if (missingOnly) return all.filter((provider) => !provider.canRun);
    return all;
  }, [initialProviderId, missingOnly, state?.providers]);

  if (!preset) return null;

  async function refresh(): Promise<void> {
    if (!preset) return;
    setLoading(true);
    setError(null);
    try {
      const next = await recheckAgentCliSetup(preset);
      setState(next);
      onSetupChanged?.(setupStateToProviderScan(next));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function prepareInstall(provider: AgentCliSetupCard): Promise<void> {
    if (!preset || !provider.installable) return;
    setBusyProviderId(provider.providerId);
    setError(null);
    setInstallResult(null);
    try {
      const next = await prepareAgentCliInstall(
        preset,
        provider.providerId,
        provider.recommendedMethodId ?? provider.installMethods[0]?.id ?? null,
      );
      setConfirmation(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyProviderId(null);
    }
  }

  async function runConfirmedInstall(): Promise<void> {
    if (!confirmation) return;
    setBusyProviderId(confirmation.providerId);
    setError(null);
    try {
      const result = await confirmAgentCliInstall(confirmation.confirmationId);
      setInstallResult(result);
      setConfirmation(null);
      if (fixture?.allowOwnedInstall !== true) await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyProviderId(null);
    }
  }

  async function cancelPreparedInstall(): Promise<void> {
    if (!confirmation) return;
    setBusyProviderId(confirmation.providerId);
    setError(null);
    try {
      await cancelAgentCliInstall(confirmation.confirmationId);
      setConfirmation(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyProviderId(null);
    }
  }

  async function copyCommand(command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      setError("Copy failed. Select and copy the command manually.");
    }
  }

  function openExternal(url: string): void {
    void invoke("open_url_in_browser", { url })
      .catch(() => {
        try { window.open(url, "_blank", "noopener,noreferrer"); } catch { /* browser-only fallback */ }
      });
  }

  return (
    <section
      className={embedded ? "agent-cli-setup embedded" : "agent-cli-setup"}
      data-debug-id="agent-cli-setup-assistant"
      aria-label="Agent CLI Setup Assistant"
    >
      <div className="agent-cli-setup-header">
        <div>
          <strong>Agent CLI Setup Assistant</strong>
          <span>
            {state
              ? `${state.target.label} · commands run on ${state.target.commandRunsOn}`
              : loading
                ? "Checking setup…"
                : "Ready to check agent CLI setup"}
          </span>
        </div>
        <div className="agent-cli-setup-header-actions">
          <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={() => void refresh()} disabled={loading || Boolean(fixture)}>
            Recheck
          </button>
          {onClose && (
            <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>

      {error && <div className="agent-cli-setup-error">{error}</div>}
      {installResult && (
        <div className={installResult.success ? "agent-cli-setup-result ok" : "agent-cli-setup-result warn"}>
          {installResult.success
            ? fixture?.allowOwnedInstall === true
              ? "Owned installer fixture finished."
              : "Installer finished. Recheck completed."
            : "Installer exited with an error."}
          {installResult.stderrTail && <pre>{installResult.stderrTail}</pre>}
        </div>
      )}

      <div className="agent-cli-setup-list">
        {providers.map((provider) => {
          const command = provider.installMethods[0]?.command;
          return (
            <div
              key={provider.providerId}
              className="agent-cli-setup-card"
              data-agent-cli-provider={provider.providerId}
              data-shellx-release-observe="title"
              title={agentCliSetupReceipt(provider)}
            >
              <div className="agent-cli-setup-card-main">
                <span className={provider.canRun ? "agent-cli-setup-dot ok" : "agent-cli-setup-dot warn"} />
                <div>
                  <strong>{provider.displayName}</strong>
                  <span>{provider.canRun ? provider.version ?? provider.binary ?? "ready" : provider.detail ?? "missing CLI"}</span>
                  {provider.accessNote && <em>{provider.accessNote}</em>}
                </div>
              </div>
              <div className="agent-cli-setup-card-actions">
                <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={() => openExternal(provider.docsUrl)} disabled={Boolean(fixture) && fixture?.allowOwnedExternal !== true}>
                  Open docs
                </button>
                {command && (
                  <button
                    type="button"
                    className="mp-action-btn mp-action-btn-secondary"
                    onClick={() => void copyCommand(command)}
                    disabled={Boolean(fixture) && fixture?.allowOwnedClipboard !== true}
                  >
                    Copy command
                  </button>
                )}
                {provider.installable && (
                  <button data-debug-id="surface-components-agentclisetupassistant-5"
                    type="button"
                    className="mp-action-btn"
                    onClick={() => void prepareInstall(provider)}
                    disabled={(Boolean(fixture) && fixture?.allowOwnedInstall !== true) || busyProviderId === provider.providerId}
                  >
                    {busyProviderId === provider.providerId ? "Preparing…" : "Install"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {!loading && providers.length === 0 && (
          <div className="agent-cli-setup-empty">No setup cards are available for this target.</div>
        )}
      </div>

      {confirmation && (
        <div
          className="agent-cli-setup-confirm"
          data-debug-id="agent-cli-setup-confirm"
          data-shellx-release-observe="title"
          title={agentCliInstallConfirmationReceipt(confirmation)}
        >
          <div ref={confirmationRef} className="agent-cli-setup-confirm-panel" role="alertdialog" aria-modal="true" aria-label={`Install ${confirmation.displayName}`}>
            <div className="agent-cli-setup-confirm-title">
              <strong>Install {confirmation.displayName}</strong>
              <span>{confirmation.target.label} · {confirmation.methodLabel}</span>
            </div>
            <p><strong>{confirmation.target.commandRunsOn}</strong>: {confirmation.warning}</p>
            {confirmation.installerSourceUrl && confirmation.artifactSha256 && (
              <dl className="agent-cli-setup-artifact">
                <div><dt>Source</dt><dd>{confirmation.installerSourceUrl}</dd></div>
                <div><dt>Version</dt><dd>{confirmation.detectedVersion ?? "Not declared"}</dd></div>
                <div><dt>Size</dt><dd>{confirmation.artifactBytes?.toLocaleString() ?? "Unknown"} bytes</dd></div>
                <div><dt>SHA-256</dt><dd>{confirmation.artifactSha256}</dd></div>
                <div><dt>Verification</dt><dd>{confirmation.verification}</dd></div>
              </dl>
            )}
            <pre className="agent-cli-setup-command">{confirmation.command}</pre>
            <div className="agent-cli-setup-confirm-links">
              <button type="button" onClick={() => openExternal(confirmation.docsUrl)} disabled={Boolean(fixture) && fixture?.allowOwnedExternal !== true}>
                Open docs
              </button>
              <button type="button" onClick={() => void copyCommand(confirmation.command)} disabled={Boolean(fixture) && fixture?.allowOwnedClipboard !== true}>
                Copy command
              </button>
            </div>
            <div className="agent-cli-setup-confirm-actions">
              <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={() => void cancelPreparedInstall()} disabled={(Boolean(fixture) && fixture?.allowOwnedInstall !== true) || busyProviderId === confirmation.providerId} data-dialog-initial-focus="true">
                Cancel
              </button>
              <button data-debug-id="surface-components-agentclisetupassistant-9" type="button" className="mp-action-btn" onClick={() => void runConfirmedInstall()} disabled={(Boolean(fixture) && fixture?.allowOwnedInstall !== true) || busyProviderId === confirmation.providerId}>
                {busyProviderId === confirmation.providerId ? "Installing…" : "Run installer"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function agentCliInstallConfirmationReceipt(confirmation: AgentCliInstallConfirmation): string {
  return [
    "Agent CLI install confirmation receipt",
    `id=${confirmation.confirmationId}`,
    `provider=${confirmation.providerId}`,
    `method=${confirmation.methodId}`,
    `command=${confirmation.command}`,
  ].join(" · ");
}

export function AgentCliSetupDialog({
  preset,
  initialProviderId,
  onSetupChanged,
  onClose,
  missingOnly,
  fixture,
}: {
  preset: ConnectionPreset | null;
  initialProviderId?: AgentId | string | null;
  onSetupChanged?: (providers: ConnectionProviderScanEntry[]) => void;
  onClose: () => void;
  missingOnly?: boolean;
  fixture?: AgentCliSetupFixture;
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(Boolean(preset), dialogRef, onClose);
  if (!preset) return null;
  return (
    <div
      className="agent-cli-setup-dialog-backdrop"
      data-debug-id="agent-cli-setup-dialog"
      onClick={onClose}
    >
      <div ref={dialogRef} data-debug-id="surface-components-agentclisetupassistant-11" className="agent-cli-setup-dialog" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Agent CLI setup">
        <AgentCliSetupAssistant
          preset={preset}
          initialProviderId={initialProviderId}
          onSetupChanged={onSetupChanged}
          onClose={onClose}
          missingOnly={missingOnly}
          fixture={fixture}
        />
      </div>
    </div>
  );
}

function agentCliSetupReceipt(provider: AgentCliSetupCard): string {
  const detail = provider.version ? `version ${provider.version}` : `status ${provider.status}`;
  return `Agent CLI setup receipt: ${detail}`.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200);
}
