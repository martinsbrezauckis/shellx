import type { JSX, MouseEvent } from "react";

import type { BrowserVaultFillCandidate } from "../vaultFillCandidates";

interface BrowserVaultFillPanelProps {
  busy: boolean;
  candidates: BrowserVaultFillCandidate[];
  error: string | null;
  onFillCandidate: (candidate: BrowserVaultFillCandidate, event: MouseEvent<HTMLButtonElement>) => void;
}

export function BrowserVaultFillPanel({
  busy,
  candidates,
  error,
  onFillCandidate,
}: BrowserVaultFillPanelProps): JSX.Element {
  return (
    <section
      id="shellx-browser-vault-fill-panel"
      className="shellx-browser-header-popover shellx-browser-docked-popover shellx-browser-vault-fill-panel"
      data-debug-id="shellx-browser-vault-fill-panel"
      aria-labelledby="shellx-browser-vault-fill-menu"
    >
      <div className="shellx-browser-vault-fill-head">
        <strong>Fill from Vault</strong>
        <span>{error ? "Vault unavailable" : `${candidates.length} match${candidates.length === 1 ? "" : "es"}`}</span>
      </div>
      {error ? (
        <div className="shellx-browser-vault-fill-empty" data-debug-id="shellx-browser-vault-fill-unavailable">
          Unlock Vault, then return to this page. ShellX will retry saved-secret detection automatically.
        </div>
      ) : candidates.length === 0 ? (
        <div className="shellx-browser-vault-fill-empty">No matching password, API key, or token fields on this page.</div>
      ) : (
        <div className="shellx-browser-vault-fill-list">
          {candidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className="shellx-browser-vault-fill-suggestion"
              onClick={(event) => onFillCandidate(candidate, event)}
              disabled={busy}
              data-debug-id="shellx-browser-vault-fill-suggestion"
              title={`Fill ${candidate.fieldLabel}`}
            >
              <span className="shellx-browser-vault-fill-kind">{candidate.fieldKind}</span>
              <span className="shellx-browser-vault-fill-main">
                <strong>{candidate.label}</strong>
                <small>{candidate.description}</small>
                <span className="shellx-browser-vault-fill-target">Target: {candidate.fieldLabel}</span>
              </span>
              {candidate.userOnly && <span className="shellx-browser-vault-fill-user-only">user</span>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
