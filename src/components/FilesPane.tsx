import { useEffect, useMemo, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../lib/tauri-bridge";
import {
  folderDisplayLabel,
  folderPathsEqual,
  joinFolderPath,
  normalizeFolderPath,
  parentFolderPath,
} from "../lib/folder-path";
import { ShellIcon } from "./icons";

type FileGit = "M" | "A" | "D" | "U" | null;

interface FsEntry {
  name: string;
  kind: "dir" | "file";
  size: number;
  git_status: FileGit;
}

export function FilesPane({
  activeTabId,
  connectionId,
  cwd,
  onPreviewFile,
  onAttachPaths,
}: {
  activeTabId?: string | null;
  connectionId?: string | null;
  cwd: string;
  onPreviewFile: (path: string) => void;
  onAttachPaths?: (paths: string[]) => void;
}): JSX.Element {
  const [currentFolder, setCurrentFolder] = useState(() => normalizeFolderPath(cwd));
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [fileQuery, setFileQuery] = useState("");

  const fullPath = normalizeFolderPath(currentFolder || cwd);
  const cwdFolder = normalizeFolderPath(cwd);
  const parentFolder = parentFolderPath(currentFolder);
  const atSessionFolder = folderPathsEqual(currentFolder, cwd);
  const desktopHost = inTauri();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setEntries(null);
    if (!cwd || !desktopHost) return;
    (async () => {
      try {
        const res = await invoke<FsEntry[]>("list_project_files", {
          path: fullPath,
          tabId: activeTabId ?? undefined,
          connectionId: connectionId ?? undefined,
        });
        if (!cancelled) setEntries(res);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [fullPath, cwd, activeTabId, connectionId, desktopHost]);

  useEffect(() => {
    setCurrentFolder(normalizeFolderPath(cwd));
    setFileQuery("");
  }, [cwd]);
  useEffect(() => { setSelectedPaths(new Set()); }, [fullPath]);

  const goUp = () => {
    const parent = parentFolderPath(currentFolder);
    if (!parent) return;
    setCurrentFolder(parent);
    setFileQuery("");
  };
  const enterDir = (name: string) => {
    setCurrentFolder(joinFolderPath(fullPath, name));
    setFileQuery("");
  };
  const resetFolderToCwd = () => {
    setCurrentFolder(cwdFolder);
    setFileQuery("");
  };
  const toggleSelected = (path: string): void => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const attachPaths = (paths: string[]): void => {
    if (paths.length === 0 || !onAttachPaths) return;
    onAttachPaths(paths);
    setSelectedPaths(new Set());
  };
  const selectedCount = selectedPaths.size;
  const canAttach = Boolean(onAttachPaths);
  const trimmedFileQuery = fileQuery.trim().toLowerCase();
  const visibleEntries = useMemo(() => {
    if (!entries) return null;
    if (!trimmedFileQuery) return entries;
    return entries.filter((entry) => {
      const git = entry.git_status?.toLowerCase() ?? "";
      return entry.name.toLowerCase().includes(trimmedFileQuery) || git.includes(trimmedFileQuery);
    });
  }, [entries, trimmedFileQuery]);

  return (
    <div className="fileview">
      <div className="fv-head">
        <span className="fv-path" title={fullPath}>
          {folderDisplayLabel(fullPath, cwd)}
        </span>
        <label className="fv-search" title="Search current folder">
          <ShellIcon name="search" size={12} />
          <input
            type="search"
            data-debug-id="files-search-input"
            data-shellx-release-observe="value"
            value={fileQuery}
            onChange={(event) => setFileQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search current folder"
          />
        </label>
        {selectedCount > 0 && (
          <div className="fv-selection" aria-label={`${selectedCount} selected file${selectedCount === 1 ? "" : "s"}`}>
            <span>{selectedCount} selected</span>
            <button
              type="button"
              className="fv-action"
              onClick={() => attachPaths(Array.from(selectedPaths))}
              disabled={!canAttach}
              title={canAttach ? "Attach selected files to the composer" : "Attach handler unavailable"}
            >
              <ShellIcon name="paperclip" size={12} />
              Attach
            </button>
            <button
              type="button"
              className="fv-action fv-action-icon"
              onClick={() => setSelectedPaths(new Set())}
              title="Clear selected files"
              aria-label="Clear selected files"
            >
              <ShellIcon name="close" size={12} />
            </button>
          </div>
        )}
        {parentFolder && (
          <button type="button" className="fv-up" onClick={goUp} title="Up one level" aria-label="Up one level">
            <ShellIcon name="arrow-up" size={13} />
          </button>
        )}
        {!atSessionFolder && (
          <button type="button" className="fv-up" onClick={resetFolderToCwd} title="Back to session folder" aria-label="Back to session folder">
            <ShellIcon name="rotate" size={13} />
          </button>
        )}
      </div>
      {error && (
        <div className="rail-empty">
          <div className="rail-empty-line">Can't list files.</div>
          <div className="rail-empty-hint"><code>{error}</code></div>
        </div>
      )}
      {!error && !cwdFolder && (
        <div className="rail-empty">
          <div className="rail-empty-line">No session folder.</div>
          <div className="rail-empty-hint">Open or connect a session to browse files.</div>
        </div>
      )}
      {!error && cwdFolder && !desktopHost && (
        <div className="rail-empty">
          <div className="rail-empty-line">Files need the desktop host.</div>
          <div className="rail-empty-hint">Run ShellX as a desktop app to browse the active session folder.</div>
        </div>
      )}
      {!error && cwdFolder && desktopHost && entries === null && (
        <div className="rail-empty"><div className="rail-empty-line">Loading...</div></div>
      )}
      {!error && entries && entries.length === 0 && (
        <div className="rail-empty"><div className="rail-empty-line">Empty folder.</div></div>
      )}
      {!error && entries && entries.length > 0 && visibleEntries?.length === 0 && (
        <div className="rail-empty">
          <div className="rail-empty-line">No files match.</div>
          <div className="rail-empty-hint"><code>{fileQuery}</code></div>
        </div>
      )}
      {!error && visibleEntries && visibleEntries.map((entry) => {
        const fullChild = joinFolderPath(fullPath, entry.name);
        const isSelected = selectedPaths.has(fullChild);
        return (
          <div
            key={entry.name}
            className={`fv-row ${entry.kind}${isSelected ? " selected" : ""}`}
            draggable={entry.kind === "file"}
            onDragStart={(event) => {
              if (entry.kind !== "file") {
                event.preventDefault();
                return;
              }
              event.dataTransfer.setData("application/x-shellx-file", fullChild);
              event.dataTransfer.effectAllowed = "copy";
            }}
          >
            {entry.kind === "file" && (
              <button
                type="button"
                className={`fv-select ${isSelected ? "active" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleSelected(fullChild);
                }}
                title={isSelected ? "Remove from selection" : "Select file"}
                aria-label={isSelected ? `Remove ${entry.name} from selection` : `Select ${entry.name}`}
              >
                <ShellIcon name={isSelected ? "check" : "square"} size={12} />
              </button>
            )}
            {entry.kind === "dir" && <span className="fv-select-spacer" />}
            <button data-debug-id="surface-components-filespane-7"
              type="button"
              className="fv-row-main"
              onClick={() => {
                if (entry.kind === "dir") enterDir(entry.name);
                else onPreviewFile(fullChild);
              }}
              title={`${entry.kind} - ${entry.size} bytes${entry.kind === "file" ? " - preview; select, attach, or drag onto composer" : " - open folder"}`}
            >
              <span className="fv-ic">
                <ShellIcon name={entry.kind === "dir" ? "folder" : "file"} size={14} />
              </span>
              <span className="fv-name">{entry.name}</span>
            </button>
            {entry.kind === "file" && (
              <span className="fv-row-actions">
                <button
                  type="button"
                  className="fv-row-action"
                  onClick={(event) => {
                    event.stopPropagation();
                    attachPaths([fullChild]);
                  }}
                  disabled={!canAttach}
                  title={canAttach ? "Attach this file to the composer" : "Attach handler unavailable"}
                  aria-label={`Attach ${entry.name}`}
                >
                  <ShellIcon name="paperclip" size={12} />
                </button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
