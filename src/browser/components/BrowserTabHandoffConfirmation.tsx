import { useRef, type JSX, type MouseEvent } from "react";

import { useModalFocus } from "../../lib/useModalFocus";
import type { BrowserTabHandoffConfirmation, BrowserTabHandoffStatus } from "../hooks/useBrowserTabs";
import "./BrowserTabHandoffConfirmation.css";

interface BrowserTabHandoffConfirmationProps {
  busy: boolean;
  confirmation: BrowserTabHandoffConfirmation | null;
  status: BrowserTabHandoffStatus;
  onCancel: () => void;
  onConfirm: (event: MouseEvent<HTMLButtonElement>) => void;
}

function handoffContextTitle(confirmation: BrowserTabHandoffConfirmation): string {
  const value = [
    `Origin ${confirmation.currentOrigin}`,
    `URL ${confirmation.currentUrlContext}`,
    `Profile ${confirmation.profileLabel} (${confirmation.profileId})`,
    `Persistence ${confirmation.persistenceLabel}`,
    `Owner ${confirmation.ownerLabel}`,
    `Task ${confirmation.taskId}: ${confirmation.taskLabel}`,
  ].join("; ");
  return value.length > 240 ? `${value.slice(0, 239)}…` : value;
}

/** A bounded ownership review before a user-controlled tab is delegated to the active task. */
export function BrowserTabHandoffConfirmation({
  busy,
  confirmation,
  status,
  onCancel,
  onConfirm,
}: BrowserTabHandoffConfirmationProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const handoffBusy = busy || status.tone === "pending";
  useModalFocus(
    confirmation !== null,
    dialogRef,
    () => {
      if (!handoffBusy) onCancel();
    },
  );

  if (!confirmation) return null;

  const complete = status.tone === "success";
  const error = status.tone === "error" ? status.message : null;
  const success = status.tone === "success" ? status.message : null;

  return (
    <div className="shellx-browser-handoff-confirmation-backdrop" data-debug-id="shellx-browser-handoff-confirmation-backdrop">
      <div
        ref={dialogRef}
        className="shellx-browser-handoff-confirmation"
        role="alertdialog"
        aria-modal="true"
        aria-busy={handoffBusy}
        aria-labelledby="shellx-browser-handoff-confirmation-title"
        aria-describedby="shellx-browser-handoff-confirmation-description"
        data-debug-id="shellx-browser-handoff-confirmation"
        tabIndex={-1}
      >
        <div className="shellx-browser-handoff-confirmation-topbar">
          <span>Ownership review</span>
          <span>{complete ? "Complete" : "User confirmation required"}</span>
        </div>
        <h2 id="shellx-browser-handoff-confirmation-title">
          {complete ? "Browser tab handed off" : "Hand off this Browser tab?"}
        </h2>
        <p id="shellx-browser-handoff-confirmation-description">
          The agent receives control of this one Browser tab for the target task and may use its current page context.
        </p>
        <dl
          className="shellx-browser-handoff-confirmation-context"
          data-debug-id="shellx-browser-handoff-context"
          data-shellx-release-observe="title"
          title={handoffContextTitle(confirmation)}
        >
          <div>
            <dt>Current origin</dt>
            <dd><code>{confirmation.currentOrigin}</code></dd>
          </div>
          <div>
            <dt>URL context</dt>
            <dd>{confirmation.currentUrlContext}</dd>
          </div>
          <div>
            <dt>Profile</dt>
            <dd>{confirmation.profileLabel} <code>{confirmation.profileId}</code></dd>
          </div>
          <div>
            <dt>Persistence</dt>
            <dd>{confirmation.persistenceLabel}</dd>
          </div>
          <div>
            <dt>Current owner</dt>
            <dd>{confirmation.ownerLabel}</dd>
          </div>
          <div>
            <dt>Target task</dt>
            <dd><code>{confirmation.taskId}</code></dd>
          </div>
          <div className="shellx-browser-handoff-confirmation-task-label">
            <dt>Task label</dt>
            <dd>{confirmation.taskLabel}</dd>
          </div>
        </dl>
        <p
          className="shellx-browser-handoff-confirmation-vault"
          data-debug-id="shellx-browser-handoff-vault-notice"
          data-shellx-release-observe="title"
          title="Vault secrets still require a separate approval. This handoff does not grant Vault access."
        >
          Vault secrets still require a separate approval. This handoff does not grant Vault access.
        </p>
        {(error || success) && (
          <p
            className={`shellx-browser-handoff-confirmation-status ${error ? "error" : "success"}`}
            role={error ? "alert" : "status"}
            data-debug-id="shellx-browser-handoff-status"
            data-shellx-release-observe="title"
            title={error ?? success ?? ""}
          >
            {error || success}
          </p>
        )}
        <div className="shellx-browser-handoff-confirmation-actions">
          <button
            type="button"
            className="shellx-browser-utility-row"
            data-dialog-initial-focus="true"
            onClick={onCancel}
            disabled={handoffBusy}
            data-debug-id="shellx-browser-handoff-cancel"
            data-shellx-release-observe="focused disabled"
          >
            {complete ? "Close" : "Cancel"}
          </button>
          {!complete && (
            <button
              type="button"
              className="shellx-browser-utility-row shellx-browser-handoff-confirm-action"
              onClick={onConfirm}
              disabled={handoffBusy}
              data-debug-id="shellx-browser-handoff-confirm"
              data-shellx-release-observe="disabled"
            >
              {handoffBusy ? "Handing off tab…" : "Hand off tab"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
