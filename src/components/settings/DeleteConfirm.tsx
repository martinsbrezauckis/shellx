/**
 * src/components/settings/DeleteConfirm.tsx — typed-name confirmation
 * modal for destructive vault actions (delete-key).
 *
 * Built specifically for the Vault tab: a single misclick on a Delete
 * row should not drop an encrypted secret. The user must type the exact
 * key name into the confirm box, matching the same UX pattern GitHub
 * uses for "delete repository" — slow enough to feel deliberate, fast
 * enough not to be obnoxious.
 *
 * Mounted from VaultTab.tsx; closes on Esc or Cancel; fires `onConfirm`
 * when the typed name matches and the user clicks the destructive button
 * (or hits Enter inside the input).
 *
 */
import { useEffect, useRef, useState, type JSX } from "react";

export function DeleteConfirm({
  open,
  keyName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  keyName: string;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element | null {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

 // Reset the typed-name buffer every time the modal opens so a previous
 // session's text doesn't pre-arm a different key's deletion.
  useEffect(() => {
    if (open) {
      setTyped("");
 // Microtask focus — the input isn't mounted on the prior render.
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open, keyName]);

 // Esc cancels. We don't intercept Enter at window level — the input
 // form-submit handles it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const canDelete = typed === keyName;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal vault-delete-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="vault-delete-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="vault-delete-title">Delete vault secret?</h3>
        <p className="vault-delete-body">
          This permanently removes <code>{keyName}</code> from the
          encrypted vault. The deletion is whole-file: the on-disk
          <code> vault.enc</code> is re-encrypted without this entry,
          so there's no undo.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canDelete) onConfirm();
          }}
        >
          <label className="vault-delete-label">
            Type <code>{keyName}</code> to confirm:
            <input
              ref={inputRef}
              type="text"
              className="settings-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <div className="vault-edit-actions">
            <button type="button" className="settings-pill" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="submit"
              className={`settings-pill vault-action-delete ${canDelete ? "active" : ""}`}
              disabled={!canDelete}
            >
              Delete {keyName}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
