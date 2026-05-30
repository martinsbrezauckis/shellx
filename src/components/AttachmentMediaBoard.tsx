import type { JSX } from "react";
import type { ComposerAttachmentChip, ComposerAttachmentKind } from "./BottomPanel";
import { SafeImg, SafeVideo } from "./MediaPreview";
import { ShellIcon, type ShellIconName } from "./icons";
import type { SessionAttachmentItem, SessionMediaItem } from "../lib/session-media";

interface AttachmentMediaBoardProps {
  open: boolean;
  attachments: ComposerAttachmentChip[];
  sessionAttachments: SessionAttachmentItem[];
  images: SessionMediaItem[];
  videos: SessionMediaItem[];
  tabId?: string | null;
  sessionCwd?: string;
  onClose: () => void;
  onAttach: () => void;
  onAttachScreenshot: () => void;
  onRemoveAttachment: (id: string) => void;
  onPreviewFile: (path: string) => void;
  onInsertPrompt: (text: string) => void;
}

function attachmentIcon(kind: ComposerAttachmentKind): ShellIconName {
  if (kind === "image") return "image";
  if (kind === "text") return "file";
  return "paperclip";
}

function fileName(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] || path;
  const parts = clean.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || clean || "file";
}

function attachmentPrompt(
  action: "inspect" | "summarize" | "find",
  attachments: ComposerAttachmentChip[],
): string | null {
  const fileWord = attachments.length === 1 ? "attached file" : "attached files";
  if (action === "inspect") {
    return `Inspect the ${fileWord}. Summarize what each contains and point out anything important I should notice.`;
  }
  if (action === "summarize") {
    return `Summarize the ${fileWord}. Keep it concise and include filenames when comparing them.`;
  }
  const query = window.prompt("Find what in the attached files?");
  const trimmed = query?.trim();
  if (!trimmed) return null;
  return `Find "${trimmed}" in the ${fileWord}. Report every relevant match with filename and context.`;
}

function EmptyLine({ label }: { label: string }): JSX.Element {
  return <div className="asset-board-empty">{label}</div>;
}

export function AttachmentMediaBoard({
  open,
  attachments,
  sessionAttachments,
  images,
  videos,
  tabId,
  sessionCwd,
  onClose,
  onAttach,
  onAttachScreenshot,
  onRemoveAttachment,
  onPreviewFile,
  onInsertPrompt,
}: AttachmentMediaBoardProps): JSX.Element | null {
  if (!open) return null;

  const mediaCount = images.length + videos.length;
  const attachmentCount = attachments.length + sessionAttachments.length;
  const canPromptAttachments = attachments.length > 0;
  const runAttachmentPrompt = (action: "inspect" | "summarize" | "find") => {
    const text = attachmentPrompt(action, attachments);
    if (!text) return;
    onInsertPrompt(text);
    onClose();
  };

  return (
    <div className="pmodal-backdrop asset-board-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Attachment and media board">
      <div className="pmodal asset-board-modal" onClick={(event) => event.stopPropagation()}>
        <header className="pmodal-hdr asset-board-head">
          <div className="asset-board-title">
            <ShellIcon name="paperclip" size={14} />
            <span className="pmodal-title asset-board-title-text">Attachment & Media Board</span>
          </div>
          <div className="asset-board-meta">
            <span>{attachmentCount} attached</span>
            <span>{mediaCount} session media</span>
          </div>
          <button type="button" className="pmodal-x" onClick={onClose} aria-label="Close">
            <ShellIcon name="close" size={12} />
          </button>
        </header>

        <div className="pmodal-body asset-board-body">
          <section className="asset-board-section">
            <div className="asset-board-section-head">
              <div className="asset-board-section-title-row">
                <div className="asset-board-section-title">Pending attachments</div>
              </div>
              <div className="asset-board-actions">
                <button type="button" className="settings-pill" onClick={onAttach} title="Attach file">
                  <ShellIcon name="paperclip" size={12} />
                  Attach
                </button>
                <button type="button" className="settings-pill" onClick={onAttachScreenshot} title="Attach app screenshot">
                  <ShellIcon name="camera" size={12} />
                  Shot
                </button>
                <button type="button" className="settings-pill" onClick={() => runAttachmentPrompt("inspect")} disabled={!canPromptAttachments}>
                  Inspect
                </button>
                <button type="button" className="settings-pill" onClick={() => runAttachmentPrompt("summarize")} disabled={!canPromptAttachments}>
                  Summarize
                </button>
                <button type="button" className="settings-pill" onClick={() => runAttachmentPrompt("find")} disabled={!canPromptAttachments}>
                  Find
                </button>
              </div>
            </div>

            {attachments.length === 0 ? (
              <EmptyLine label="No pending attachments." />
            ) : (
              <div className="asset-board-list">
                {attachments.map((attachment) => (
                  <div key={attachment.id} className={`asset-board-row asset-board-row-${attachment.kind}`}>
                    <ShellIcon name={attachmentIcon(attachment.kind)} size={15} />
                    <button
                      type="button"
                      className="asset-board-row-main"
                      onClick={() => onPreviewFile(attachment.path)}
                      title={attachment.path}
                    >
                      <span className="asset-board-row-name">{attachment.label || fileName(attachment.path)}</span>
                      <span className="asset-board-row-path">{attachment.path}</span>
                    </button>
                    <div className="asset-board-row-actions">
                      {attachment.inlined && <span className="asset-board-tag">inline</span>}
                      <button
                        type="button"
                        className="settings-pill"
                        onClick={() => onPreviewFile(attachment.path)}
                        title="Preview file"
                      >
                        <ShellIcon name="external-link" size={12} />
                      </button>
                      <button
                        type="button"
                        className="settings-pill settings-pill-danger"
                        onClick={() => onRemoveAttachment(attachment.id)}
                        title="Remove attachment"
                      >
                        <ShellIcon name="trash" size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="asset-board-section">
            <div className="asset-board-section-head">
              <div className="asset-board-section-title-row">
                <div className="asset-board-section-title">Session attachments</div>
                <span className="asset-board-count">{sessionAttachments.length}</span>
              </div>
            </div>
            {sessionAttachments.length === 0 ? (
              <EmptyLine label="No sent attachments in this session." />
            ) : (
              <div className="asset-board-list">
                {sessionAttachments.map((attachment) => (
                  <div key={attachment.id} className={`asset-board-row asset-board-row-${attachment.kind}`}>
                    <ShellIcon name={attachmentIcon(attachment.kind)} size={15} />
                    <button
                      type="button"
                      className="asset-board-row-main"
                      onClick={() => onPreviewFile(attachment.path)}
                      title={attachment.path}
                    >
                      <span className="asset-board-row-name">{attachment.title || fileName(attachment.path)}</span>
                      <span className="asset-board-row-path">{attachment.path}</span>
                    </button>
                    <div className="asset-board-row-actions">
                      <button
                        type="button"
                        className="settings-pill"
                        onClick={() => onPreviewFile(attachment.path)}
                        title="Preview file"
                      >
                        <ShellIcon name="external-link" size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="asset-board-section">
            <div className="asset-board-section-head">
              <div className="asset-board-section-title-row">
                <div className="asset-board-section-title">Images</div>
                <span className="asset-board-count">{images.length}</span>
              </div>
            </div>
            {images.length === 0 ? (
              <EmptyLine label="No images in this session." />
            ) : (
              <div className="asset-board-grid">
                {images.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="asset-board-media"
                    onClick={() => onPreviewFile(item.path)}
                    title={item.path}
                  >
                    <SafeImg
                      src={item.path}
                      alt={item.title}
                      tabId={tabId ?? undefined}
                      sessionCwd={sessionCwd}
                      className="asset-board-thumb"
                    />
                    <span>{item.title}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="asset-board-section">
            <div className="asset-board-section-head">
              <div className="asset-board-section-title-row">
                <div className="asset-board-section-title">Videos</div>
                <span className="asset-board-count">{videos.length}</span>
              </div>
            </div>
            {videos.length === 0 ? (
              <EmptyLine label="No videos in this session." />
            ) : (
              <div className="asset-board-grid">
                {videos.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="asset-board-media"
                    onClick={() => onPreviewFile(item.path)}
                    title={item.path}
                  >
                    <SafeVideo
                      src={item.path}
                      title={item.title}
                      tabId={tabId ?? undefined}
                      sessionCwd={sessionCwd}
                      className="asset-board-thumb"
                    />
                    <span>{item.title}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
