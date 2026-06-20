import type { JSX } from "react";

import { ShellIcon } from "../../components/icons";
import type { BrowserTransferEntry } from "../types";

interface DownloadSidecarProps {
  open: boolean;
  busy: boolean;
  downloads: BrowserTransferEntry[];
  uploads: BrowserTransferEntry[];
  defaultDownloadFolder: string;
  onDefaultDownloadFolderChange: (value: string) => void;
  onChooseDefaultDownloadFolder: () => void;
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
  if (entry.bytes) bits.push(`${entry.bytes.toLocaleString()} bytes`);
  return bits.join(" · ");
}

function transferStatusLabel(entry: BrowserTransferEntry): string {
  if (entry.status === "completed") return "Saved";
  if (entry.status === "requested") return entry.reason?.startsWith("userPageSave:") ? "Queued" : "Waiting";
  return entry.status;
}

export function DownloadSidecar({
  open,
  busy,
  downloads,
  uploads,
  defaultDownloadFolder,
  onDefaultDownloadFolderChange,
  onChooseDefaultDownloadFolder,
  onClose,
}: DownloadSidecarProps): JSX.Element | null {
  if (!open) return null;
  const transfers = [...downloads, ...uploads].slice().reverse();

  return (
    <aside className="shellx-browser-left-sidecar shellx-browser-download-sidecar" data-debug-id="shellx-browser-download-sidecar">
      <div className="shellx-browser-download-head">
        <h2>Downloads</h2>
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
            aria-label="Default download folder"
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
          </div>
        ))}
        {transfers.length === 0 && (
          <div className="shellx-browser-empty-state">No downloads yet</div>
        )}
      </section>
    </aside>
  );
}
