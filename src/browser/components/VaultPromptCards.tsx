import type { JSX, MouseEvent } from "react";

import type { VaultApprovalPrompt } from "../../lib/vault-approval-prompts";
import { ShellIcon, type ShellIconName } from "../../components/icons";

interface VaultPromptCardsProps {
  prompts: VaultApprovalPrompt[];
  busy: boolean;
  getIconName: (prompt: VaultApprovalPrompt) => ShellIconName;
  getDebugSuffix: (prompt: VaultApprovalPrompt) => string;
  onAction: (
    prompt: VaultApprovalPrompt,
    actionKind?: string,
    event?: MouseEvent<HTMLButtonElement>,
  ) => void;
}

export function VaultPromptCards({
  prompts,
  busy,
  getIconName,
  getDebugSuffix,
  onAction,
}: VaultPromptCardsProps): JSX.Element {
  return (
    <section
      className={`shellx-browser-vault-prompt-stack ${prompts.length === 0 ? "is-empty" : ""}`}
      data-debug-id="shellx-browser-vault-prompt-stack"
      aria-label="Vault requests"
    >
      {prompts.slice(0, 3).map((prompt) => (
        <article
          key={prompt.id}
          className={`shellx-browser-vault-prompt-card ${prompt.tone}`}
          data-debug-id="shellx-browser-vault-prompt-card"
          data-prompt-id={getDebugSuffix(prompt)}
        >
          <div className="shellx-browser-vault-card-head">
            <span className="shellx-browser-vault-card-icon">
              <ShellIcon name={getIconName(prompt)} size={13} />
            </span>
            <div>
              <h3>{prompt.title}</h3>
              <p>{prompt.summary}</p>
            </div>
          </div>
          <div className="shellx-browser-vault-card-details">
            {prompt.detailLines.slice(0, 3).map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
          <div className="shellx-browser-vault-card-actions">
            {prompt.secondaryAction && (
              <button
                type="button"
                className="shellx-browser-secondary"
                onClick={(event) => onAction(prompt, prompt.secondaryAction?.kind, event)}
                disabled={busy}
                data-debug-id={`shellx-browser-vault-prompt-${prompt.secondaryAction.kind}`}
              >
                {prompt.secondaryAction.label}
              </button>
            )}
            {prompt.primaryAction && (
              <button
                type="button"
                className="shellx-browser-primary"
                onClick={(event) => onAction(prompt, prompt.primaryAction?.kind, event)}
                disabled={busy}
                data-debug-id={`shellx-browser-vault-prompt-${prompt.primaryAction.kind}`}
              >
                {prompt.primaryAction.label}
              </button>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}
