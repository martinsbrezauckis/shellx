import type { JSX, MouseEvent } from "react";

import { ShellIcon } from "../../components/icons";
import type { BrowserTransferEntry } from "../types";

interface DownloadSidecarProps {
  open: boolean;
  busy: boolean;
  downloads: BrowserTransferEntry[];
  uploads: BrowserTransferEntry[];
  interruptedNativeDownloadStageCount: number;
  nativeDownloadCleanupStateUnknown: boolean;
  defaultDownloadFolder: string;
  downloadFolderError?: string | null;
  onDefaultDownloadFolderChange: (value: string) => void;
  onChooseDefaultDownloadFolder: () => void;
  onApproveDownload: (entry: BrowserTransferEntry, event: MouseEvent<HTMLButtonElement>) => void;
  onDeclineDownload: (entry: BrowserTransferEntry, event: MouseEvent<HTMLButtonElement>) => void;
  onClose: () => void;
}

function transferTitle(entry: BrowserTransferEntry): string {
  return entry.displayName || entry.url || entry.filePath || entry.transferId;
}

function transferDestination(entry: BrowserTransferEntry): string {
  return entry.finalPath || entry.destination || entry.destinationOrigin || "No destination selected";
}

function transferDetail(entry: BrowserTransferEntry): string {
  const bits = [transferStatusLabel(entry), entry.reason].filter(Boolean);
  if (entry.bytes != null) bits.push(`${entry.bytes.toLocaleString()} bytes`);
  return bits.join(" · ");
}

function transferStatusLabel(entry: BrowserTransferEntry): string {
  if (entry.status === "requested") return entry.reason?.startsWith("userPageSave:") ? "Queued" : "Waiting for approval";
  return {
    approved: "Approval recorded",
    cleanupPending: "Cleanup needed",
    completed: "Saved",
    declined: "Declined",
    failed: "Failed",
    finalizing: "Finalizing download",
    inProgress: "Downloading",
  }[entry.status] ?? "Status unavailable";
}

export function DownloadSidecar({
  open,
  busy,
  downloads,
  uploads,
  interruptedNativeDownloadStageCount,
  nativeDownloadCleanupStateUnknown,
  defaultDownloadFolder,
  downloadFolderError,
  onDefaultDownloadFolderChange,
  onChooseDefaultDownloadFolder,
  onApproveDownload,
  onDeclineDownload,
  onClose,
}: DownloadSidecarProps): JSX.Element | null {
  if (!open) return null;
  const transfers = [...downloads, ...uploads].slice().reverse();

  return (
    <aside
      id="shellx-browser-download-sidecar"
      className="shellx-browser-left-sidecar shellx-browser-download-sidecar"
      data-debug-id="shellx-browser-download-sidecar"
      aria-labelledby="shellx-browser-downloads-menu"
    >
      <div className="shellx-browser-download-head">
        <h2 id="shellx-browser-downloads-menu">Downloads</h2>
        <button
          type="button"
          className="shellx-browser-icon-btn"
          onClick={onClose}
          data-debug-id="shellx-browser-downloads-close"
          title="Close downloads"
          aria-label="Close downloads"
        >
          <ShellIcon name="close" size={14} />
        </button>
        <label className="shellx-browser-download-folder">
          <span>Default folder</span>
          <input
            value={defaultDownloadFolder}
            onChange={(event) => onDefaultDownloadFolderChange(event.currentTarget.value)}
            placeholder="Choose a download folder"
            data-debug-id="shellx-browser-download-folder"
            data-shellx-release-observe="value"
            aria-label="Default download folder"
            aria-invalid={Boolean(downloadFolderError)}
            aria-describedby={downloadFolderError ? "shellx-browser-download-folder-error" : undefined}
          />
          <button
            type="button"
            className="shellx-browser-secondary"
            onClick={onChooseDefaultDownloadFolder}
            disabled={busy}
            data-debug-id="shellx-browser-download-folder-choose"
          >
            <ShellIcon name="folder-open" size={13} />
            Choose
          </button>
        </label>
      </div>
      <section className="shellx-browser-download-list" data-debug-id="shellx-browser-download-list" aria-label="Browser downloads">
        {downloadFolderError && (
          <p id="shellx-browser-download-folder-error" role="alert" className="shellx-browser-error shellx-browser-download-folder-error" data-debug-id="shellx-browser-download-folder-error">
            {downloadFolderError}
          </p>
        )}
        {(nativeDownloadCleanupStateUnknown || interruptedNativeDownloadStageCount > 0) && (
          <p className="shellx-browser-download-recovery-notice" data-debug-id="shellx-browser-download-recovery-notice" role="status">
            {nativeDownloadCleanupStateUnknown
              ? "Interrupted download recovery needs inspection before new native downloads can start."
              : `${interruptedNativeDownloadStageCount} interrupted native download${interruptedNativeDownloadStageCount === 1 ? "" : "s"} ${interruptedNativeDownloadStageCount === 1 ? "is" : "are"} retained for cleanup and will not resume automatically.`}
          </p>
        )}
        {transfers.map((entry) => (
          <div key={entry.transferId} className={`shellx-browser-download-row ${entry.status}`}>
            <div className="shellx-browser-download-row-head">
              <span className="shellx-browser-download-kind">
                <ShellIcon name={entry.direction === "upload" ? "arrow-up" : "download"} size={12} />
                {entry.direction}
              </span>
              <span className="shellx-browser-download-status">{transferStatusLabel(entry)}</span>
            </div>
            <p title={transferTitle(entry)}>{transferTitle(entry)}</p>
            <small title={transferDestination(entry)}>{transferDestination(entry)}</small>
            <small>{transferDetail(entry)}</small>
            {entry.direction === "download" && entry.status === "requested" && entry.requiresApproval === true && (
              <>
                <button
                  type="button"
                  className="shellx-browser-secondary"
                  onClick={(event) => onApproveDownload(entry, event)}
                  disabled={busy}
                  data-debug-id={`shellx-browser-download-approve-${entry.transferId}`}
                >
                  Approve download
                </button>
                {entry.canDeclineNativeDownload === true && (
                  <button
                    type="button"
                    className="shellx-browser-secondary"
                    onClick={(event) => onDeclineDownload(entry, event)}
                    disabled={busy}
                    data-debug-id={`shellx-browser-download-decline-${entry.transferId}`}
                  >
                    Decline download
                  </button>
                )}
              </>
            )}
          </div>
        ))}
        {transfers.length === 0 && (
          <div className="shellx-browser-empty-state">No downloads yet</div>
        )}
      </section>
    </aside>
  );
}
