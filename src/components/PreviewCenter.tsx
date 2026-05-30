import { useEffect, type JSX } from "react";
import { FilePreviewModal } from "./FilePreviewModal";
import { WorkPreviewStage } from "./WorkPreviewPanel";
import { ShellIcon } from "./icons";
import type { PreviewCenterView } from "../lib/preview-center";
import type { WorkPreviewState } from "../lib/work-preview";

function basename(path: string | null): string {
  if (!path) return "No file selected";
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function hasWorkPreview(state: WorkPreviewState | null): boolean {
  return Boolean(state && (state.url || state.status !== "idle" || state.error));
}

export function PreviewCenter({
  open,
  view,
  filePath,
  tabId,
  sessionCwd,
  workState,
  onClose,
  onViewChange,
  onPreviewFile,
  onRunWorkPreview,
  onAskGrokToFix,
}: {
  open: boolean;
  view: PreviewCenterView;
  filePath: string | null;
  tabId?: string | null;
  sessionCwd?: string | null;
  workState: WorkPreviewState | null;
  onClose: () => void;
  onViewChange: (view: PreviewCenterView) => void;
  onPreviewFile: (path: string) => void;
  onRunWorkPreview: (path: string) => void;
  onAskGrokToFix?: (state: WorkPreviewState) => void;
}): JSX.Element | null {
  const workAvailable = hasWorkPreview(workState);
  const fileLabel = basename(filePath);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="preview-center-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Preview Center">
      <div className="preview-center-modal" onClick={(event) => event.stopPropagation()}>
        <div className="preview-center-topbar">
          <div className="preview-center-title">
            <ShellIcon name={view === "work" ? "app-window" : "file"} size={14} />
            <div>
              <div className="preview-center-kicker">Preview Center</div>
              <div className="preview-center-heading" title={view === "work" ? workState?.cwd ?? undefined : filePath ?? undefined}>
                {view === "work" ? "Work Preview" : fileLabel}
              </div>
            </div>
          </div>
          <div className="preview-center-switcher" role="tablist" aria-label="Preview mode">
            <button
              type="button"
              className={view === "file" ? "active" : ""}
              disabled={!filePath}
              onClick={() => onViewChange("file")}
              aria-selected={view === "file"}
              title={filePath ? "Show file preview" : "No file preview available"}
            >
              <ShellIcon name="file" size={12} />
              <span>File</span>
            </button>
            <button
              type="button"
              className={view === "work" ? "active" : ""}
              disabled={!workAvailable}
              onClick={() => onViewChange("work")}
              aria-selected={view === "work"}
              title={workAvailable ? "Show runnable Work Preview" : "Start a Work Preview from the Preview tab or an HTML link"}
            >
              <ShellIcon name="app-window" size={12} />
              <span>Work</span>
            </button>
          </div>
          <button type="button" className="preview-center-close" onClick={onClose} title="Close">
            <ShellIcon name="close" size={13} />
          </button>
        </div>

        <div className={`preview-center-body preview-center-body-${view}`}>
          {view === "file" ? (
            filePath ? (
              <FilePreviewModal
                open
                embedded
                path={filePath}
                tabId={tabId}
                sessionCwd={sessionCwd}
                onClose={onClose}
                onPreviewFile={onPreviewFile}
                onRunWorkPreview={onRunWorkPreview}
              />
            ) : (
              <div className="preview-center-empty">
                <div className="rail-empty-line">No file selected.</div>
                <div className="rail-empty-hint">Open a file link, attachment, image, PDF, or markdown document to preview it here.</div>
              </div>
            )
          ) : (
            <WorkPreviewStage
              state={workState}
              onAskGrokToFix={onAskGrokToFix}
              showClose={false}
            />
          )}
        </div>
      </div>
    </div>
  );
}
