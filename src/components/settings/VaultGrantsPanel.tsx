import type { JSX } from "react";

export type GrantOperation =
  | "fill"
  | "profileFill"
  | "emailCodeRead"
  | "agentWalletUse"
  | "injectEnv"
  | "providerUse"
  | "connectorUse"
  | "deposit"
  | "rawReveal";

export type GrantSummary = {
  grantId: string;
  secretRef: string;
  actorScope: string;
  operation: string;
  origin?: string | null;
  expiresAtMs?: number | null;
  revoked: boolean;
  approved: boolean;
};

export function VaultGrantsPanel({
  grants,
  busy,
  onRefresh,
  onRevoke,
}: {
  grants: GrantSummary[];
  busy: boolean;
  onRefresh: () => void;
  onRevoke: (grantId: string) => void;
}): JSX.Element {
  const now = Date.now();
  const activeGrants = grants.filter((grant) => grant.approved && !grant.revoked && (!grant.expiresAtMs || grant.expiresAtMs > now));

  return (
    <section
      className="vault-grants-panel"
      data-debug-id="shellx-vault-grants"
      data-shellx-release-observe="title"
      title={`Vault grants state: active=${activeGrants.length}; revocable=${activeGrants.length > 0 ? "yes" : "no"}`}
    >
      <div className="vault-panel-head">
        <strong>Active grants</strong>
        <span>{activeGrants.length} active</span>
        <button type="button" className="settings-pill" onClick={onRefresh} disabled={busy}>
          Refresh
        </button>
      </div>
      <p className="vault-hint">
        Secret rows control agent visibility and optional always-allowed use. This list is only for review and revoke.
      </p>
      <div className="vault-list" role="list">
        {activeGrants.map((grant) => (
          <div
            className="vault-grant-row"
            data-debug-id="shellx-vault-grant-row"
            role="listitem"
            key={grant.grantId}
          >
            <span className="vault-key-name">{grant.secretRef}</span>
            <span className="vault-hint">{formatOperation(grant.operation)}</span>
            <span className="vault-hint">{formatExpiry(grant.expiresAtMs)}</span>
            <span className="vault-hint">{formatScope(grant.actorScope)}</span>
            {grant.origin && <span className="vault-hint" title="Exact browser origin">{grant.origin}</span>}
            <button
              type="button"
              className="settings-pill"
              disabled={busy}
              onClick={() => onRevoke(grant.grantId)}
            >
              Revoke
            </button>
          </div>
        ))}
        {activeGrants.length === 0 && <div className="vault-empty">No active grants</div>}
      </div>
    </section>
  );
}

function formatOperation(operation: string): string {
  switch (operation) {
    case "ProviderUse":
    case "providerUse":
      return "Provider use";
    case "ConnectorUse":
    case "connectorUse":
      return "Connector use";
    case "Fill":
    case "fill":
      return "Browser fill";
    case "ProfileFill":
    case "profileFill":
      return "Profile fill";
    case "EmailCodeRead":
    case "emailCodeRead":
      return "Email code";
    case "AgentWalletUse":
    case "agentWalletUse":
      return "Agent wallet";
    case "InjectEnv":
    case "injectEnv":
      return "Inject env";
    case "Deposit":
    case "deposit":
      return "Deposit";
    case "RawReveal":
    case "rawReveal":
      return "Raw reveal";
    default:
      return operation;
  }
}

function formatScope(scope: string): string {
  if (scope.includes("allShellxAgents")) return "All ShellX agents";
  return scope;
}

function formatExpiry(expiresAtMs?: number | null): string {
  if (!expiresAtMs) return "Always";
  const remainingMs = expiresAtMs - Date.now();
  if (remainingMs <= 0) return "Expired";
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  if (remainingMinutes < 60) return `${remainingMinutes}m`;
  const remainingHours = Math.ceil(remainingMinutes / 60);
  return `${remainingHours}h`;
}
