/**
 * src/components/PRCreateModal.tsx — `/pr` modal .
 *
 * Triggered by typing `/pr` in the prompt input OR clicking +NEW in
 * the GitHub strip's PR section. Fields:
 * - base branch (text — could be a dropdown if we cache `gh pr base`)
 * - title (auto-drafted from session summary)
 * - body (auto-drafted with the last assistant message + tool calls)
 * - draft toggle
 * - "include transcript" toggle
 *
 * Submit calls POST /github/pr/create. On success, fires the
 * `onCreated(url)` callback which the parent surfaces as a chat-stream
 * system message.
 *
 * No `gh` shelling here — the Rust handler owns that. We just POST
 * JSON + handle the response.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { api } from "../lib/debug-api";
import { useModalFocus } from "../lib/useModalFocus";

export function PRCreateModal({
  open,
  onClose,
  defaultBase = "main",
  defaultTitle,
  defaultBody,
  transcriptAppendix,
  activeTabId,
  onCreated,
  releaseTestBoundary = false,
}: {
  open: boolean;
  onClose: () => void;
  defaultBase?: string;
  defaultTitle: string;
  defaultBody: string;
 /** Pre-built transcript chunk; appended when the user opts in. */
  transcriptAppendix: string;
  activeTabId?: string | null;
  onCreated: (url: string) => void;
  releaseTestBoundary?: boolean;
}): JSX.Element | null {
  const [base, setBase] = useState(defaultBase);
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState(defaultBody);
  const [draft, setDraft] = useState(false);
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [confirmRemoteCreate, setConfirmRemoteCreate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(open, dialogRef, onClose);

  useEffect(() => {
    if (!open) {
      setSubmitting(false);
      setError(null);
      return;
    }
    setBase(defaultBase);
    setTitle(defaultTitle);
    setBody(defaultBody);
    setConfirmRemoteCreate(false);
  }, [open, defaultBase, defaultTitle, defaultBody]);

  if (!open) return null;

  async function submit() {
    setError(null);
    setSubmitting(true);
    const fullBody = includeTranscript && transcriptAppendix
      ? `${body}\n\n---\n\n### Session transcript\n\n${transcriptAppendix}`
      : body;
    try {
 // C-NEW-1: route through api wrapper which auto-adds the
 // bearer-token header. Body shape unchanged.
      const r = await api("/github/pr/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base,
          title,
          body: fullBody,
          draft,
          tabId: activeTabId ?? null,
          confirmRemoteCreate,
          ...(releaseTestBoundary ? { releaseTestBoundary: "stop-before-remote" } : {}),
        }),
      });
      if (!r.ok) {
        const text = await r.text();
        if (releaseTestBoundary && r.status === 412) {
          let receipt = "";
          let errorCode = "";
          try {
            const parsed = JSON.parse(text) as { error?: unknown; receipt?: unknown };
            errorCode = typeof parsed.error === "string" ? parsed.error : "";
            receipt = typeof parsed.receipt === "string" ? parsed.receipt : "";
          } catch {
            // The exact release boundary below remains fail-closed.
          }
          if (errorCode === "release_test_remote_mutation_blocked"
            && receipt === "release fixture PR create stopped before remote mutation") {
            throw new Error(receipt);
          }
        }
        throw new Error(`HTTP ${r.status}: ${text}`);
      }
      const j = await r.json();
      const url = String(j?.url ?? j?.output ?? "");
      onCreated(url);
      onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div data-debug-id="surface-components-prcreatemodal-1" className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal pr-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Create pull request"
      >
        <h3>Create pull request</h3>

        <div className="settings-row">
          <label className="settings-label">Base branch</label>
          <input
            className="settings-input"
            type="text"
            data-debug-id="pr-base-input"
            data-shellx-release-observe="value"
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
        </div>

        <div className="settings-row">
          <label className="settings-label">Title</label>
          <input
            className="settings-input"
            type="text"
            data-debug-id="pr-title-input"
            data-shellx-release-observe="value"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Concise title (less than 70 chars)"
          />
        </div>

        <div className="settings-row" style={{ gridTemplateColumns: "160px 1fr" }}>
          <label className="settings-label" style={{ alignSelf: "start", paddingTop: 6 }}>Body</label>
          <textarea
            className="settings-input"
            data-debug-id="pr-body-input"
            data-shellx-release-observe="value"
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Markdown. ## Summary, ## Test plan…"
            style={{ fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.5, resize: "vertical" }}
          />
        </div>

        <div className="settings-row">
          <label className="settings-label">Options</label>
          <div className="settings-pills">
            <button
              type="button"
              className={`settings-pill ${draft ? "active" : ""}`}
              onClick={() => setDraft((v) => !v)}
              aria-pressed={draft}
              data-shellx-release-observe="pressed"
            >
              Draft
            </button>
            <button
              type="button"
              className={`settings-pill ${includeTranscript ? "active" : ""}`}
              onClick={() => setIncludeTranscript((v) => !v)}
              disabled={!transcriptAppendix}
              aria-pressed={includeTranscript}
              data-shellx-release-observe="pressed disabled title"
              title={transcriptAppendix ? "Append the session transcript as an appendix" : "No transcript captured yet"}
            >
              + transcript
            </button>
          </div>
        </div>

        <div className="settings-row">
          <label className="settings-label">Approval</label>
          <label className="settings-check">
            <input data-debug-id="surface-components-prcreatemodal-8"
              type="checkbox"
              checked={confirmRemoteCreate}
              onChange={(e) => setConfirmRemoteCreate(e.target.checked)}
              data-shellx-release-observe="checked"
            />
            <span>I approve creating this GitHub PR</span>
          </label>
        </div>

        {error && (
          <div
            className="error-banner"
            data-release-pr-create-receipt="boundary"
            data-shellx-release-observe="title"
            title={error}
            style={{ marginTop: 8 }}
          >{error}</div>
        )}

        <div className="hardcap-buttons">
          <button type="button" className="settings-pill" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button data-debug-id="surface-components-prcreatemodal-10"
            type="button"
            data-shellx-release-observe="disabled"
            className="settings-pill active"
            onClick={() => void submit()}
            disabled={submitting || !title.trim() || !base.trim() || !confirmRemoteCreate}
          >
            {submitting ? "Submitting…" : "Create PR"}
          </button>
        </div>
      </div>
    </div>
  );
}
