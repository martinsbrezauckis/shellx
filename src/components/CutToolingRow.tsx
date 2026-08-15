import type { JSX } from "react";
import {
  CUT_TOOLING_FIXTURES,
  CUT_TOOLING_STATES,
  cutToolingPresentation,
  type CutToolingStatus,
} from "../lib/cut-tooling";

export function CutToolingRow({
  status,
  checking,
  opening,
  checkSequence,
  actionError,
  onCheck,
  onOpen,
}: {
  status: CutToolingStatus;
  checking: boolean;
  opening: boolean;
  checkSequence: number;
  actionError: string | null;
  onCheck: () => void | Promise<void>;
  onOpen: () => void;
}): JSX.Element {
  const displayed = checking ? { ...status, ...CUT_TOOLING_FIXTURES.checking, target: status.target } : status;
  const presentation = cutToolingPresentation(displayed);
  const openUnavailable = displayed.actionHint
    ?? "Open is available only when ShellX can resolve an installed desktop Cut editor.";

  return (
    <div
      className="tooling-row shellx-cut-tooling"
      data-shellx-cut-tooling-row="selected-session"
      data-shellx-cut-state={displayed.status}
      data-shellx-cut-check-sequence={checkSequence}
    >
      <div className="tooling-row-top">
        <span className="tooling-name">ShellX Cut</span>
        <span className="mp-kind mp-kind-stdio">HOST</span>
        {CUT_TOOLING_STATES.map((state) => displayed.status === state ? (
          <span
            key={state}
            className={`tooling-status ${presentation.className}`}
            data-debug-id={`cut-tooling-state-${state}`}
          >
            {presentation.label}
          </span>
        ) : null)}
      </div>
      <div className="tooling-detail">
        <div>{displayed.detail}</div>
        <div>Target: <code>{displayed.target}</code></div>
        {displayed.actionHint && <div>{displayed.actionHint}</div>}
        {checkSequence > 0 && <div>Status refreshed for this selected session.</div>}
        {actionError && <div className="tooling-issue">{actionError}</div>}
      </div>
      <div className="tooling-actions">
        <button
          type="button"
          className="mp-action-btn mp-action-btn-secondary"
          data-shellx-cut-action="check"
          data-shellx-release-observe="title"
          title="Check ShellX Cut status without opening the editor"
          aria-label="Check ShellX Cut status"
          onClick={onCheck}
          disabled={checking || opening}
        >
          {checking ? "Checking…" : "Check"}
        </button>
        <button
          type="button"
          className="mp-action-btn mp-action-btn-secondary"
          data-shellx-cut-action={displayed.canOpen ? "open" : "open-unavailable"}
          data-shellx-release-observe="title"
          title={displayed.canOpen ? "Open ShellX Cut after explicit confirmation" : openUnavailable}
          aria-label={displayed.canOpen ? "Open ShellX Cut" : "ShellX Cut Open unavailable"}
          onClick={onOpen}
          disabled={!displayed.canOpen || checking || opening}
        >
          {opening ? "Opening…" : displayed.canOpen ? "Open" : "Open unavailable"}
        </button>
      </div>
    </div>
  );
}
