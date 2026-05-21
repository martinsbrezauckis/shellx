/**
 * src/components/settings/VaultTab.tsx — Settings → Vault editor.
 *
 * Flat inline editor for vault secrets (xAI API key, future
 * connectors). MicButton's no-key banner links straight here.
 *
 * Backend Tauri commands (src-tauri/src/lib.rs):
 * invoke("vault_list_keys", { prefix: null }) → string[]
 * invoke("vault_set", { key, value }) →  * invoke("vault_delete", { key }) →  * invoke("vault_status") → VaultStatus
 * invoke("vault_get", { key }) → string | null (unused
 * here — values stay
 * on disk; users replace
 * without seeing prior)
 *
 * Security boundary (see src-tauri/src/vault.rs threat model):
 * - Values are not displayed IN THIS TAB. Every value input is
 * type="password" so even screen-share / shoulder-surf reveals
 * only dots while editing.
 * - We never call vault_get from this tab — replace flows are
 * write-only. If a user wants to verify a value they already know
 * they can re-paste it.
 * - The companion `VaultPanel` (right rail) DOES expose a Reveal
 * button that calls `vault_get` and shows plaintext on demand —
 * that's intentional for power users who need to copy a stored
 * secret into another tool. The reveal modal clears its cached
 * plaintext on close, but the user has SEEN the value at that
 * point; this tab is the read-resistant surface, VaultPanel is
 * the on-demand-reveal surface.
 * - Delete uses an inline two-click confirmation (no modal); the
 * row's Delete button flips to "Confirm" for ~5s before reverting.
 *
 * UX shape * ┌─ keyring badge ────────────────────────────────────┐
 * │ keyring: ok / fallback-keyfile / unavailable │
 * ├────────────────────────────────────────────────────┤
 * │ [yellow banner if xai/api-key missing] │
 * ├────────────────────────────────────────────────────┤
 * │ Add a secret │
 * │ [namespace/name…] [password value…] [ Save ] │
 * ├────────────────────────────────────────────────────┤
 * │ filter… [ Refresh ] │
 * │ ── key list ──── │
 * │ xai/api-key [✎ Replace] [🗑] │
 * │ ┌ inline replace input on click ─────┐ │
 * │ [new value (password)] [ Save ][ ✕ ] │
 * └────────────────────────────────────────────────────┘
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Mirrors crate::vault::VaultStatus on the Rust side. camelCase wire. */
interface VaultStatus {
  initialized: boolean;
  keyringAvailable: boolean;
  usingFallbackKeyfile: boolean;
  keyCount: number;
}

/** Toast surface — single line, auto-dismissed, success or error. */
type Toast = { kind: "ok" | "err"; text: string } | null;

/** Per-row local state for the inline "Replace value" + "Delete?" flows. */
type RowState = {
  replacing: boolean;
  replaceValue: string;
  confirmingDelete: boolean;
};

/** Canonical key name for the xAI Grok API — read by voice.rs . */
const XAI_KEY = "xai/api-key";

export function VaultTab(): JSX.Element {
  const [keys, setKeys] = useState<string[]>([]);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
 // Add-secret form state (top of tab).
  const [addKey, setAddKey] = useState("");
  const [addValue, setAddValue] = useState("");
  const [adding, setAdding] = useState(false);
 // Per-row inline UI state, keyed by secret name.
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

 /** Load both the key list and the status badge in parallel. */
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const [k, s] = await Promise.all([
        invoke<string[]>("vault_list_keys", { prefix: null }),
        invoke<VaultStatus>("vault_status"),
      ]);
 // Sort alphabetically — same shape the user expects from `pass(1)`.
      setKeys([...k].sort((a, b) => a.localeCompare(b)));
      setStatus(s);
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

 // Auto-dismiss toast after 3s. Errors hang around the same time —
 // user can re-trigger the action to see it again.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(
    () => keys.filter((k) => k.toLowerCase().includes(filter.toLowerCase())),
    [keys, filter],
  );

 /** True when the XAI key is missing — drives the yellow banner. */
  const xaiMissing = useMemo(() => !keys.includes(XAI_KEY), [keys]);

 /** Update one row's inline state without disturbing the others. */
  const patchRow = useCallback((key: string, patch: Partial<RowState>) => {
    setRowState((prev) => {
      const cur: RowState = prev[key] ?? {
        replacing: false,
        replaceValue: "",
        confirmingDelete: false,
      };
      return { ...prev, [key]: { ...cur, ...patch } };
    });
  }, []);

 /** Save flow for the top "Add a secret" row. */
  async function handleAdd(): Promise<void> {
    const key = addKey.trim();
    if (!key || !addValue) return;
    setAdding(true);
    try {
      await invoke("vault_set", { key, value: addValue });
      setAddKey("");
      setAddValue("");
      setToast({ kind: "ok", text: `Saved ${key}` });
      await refresh();
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    } finally {
      setAdding(false);
    }
  }

 /** Replace-value flow on an existing row. */
  async function handleReplace(key: string): Promise<void> {
    const cur = rowState[key];
    if (!cur || !cur.replaceValue) return;
    try {
      await invoke("vault_set", { key, value: cur.replaceValue });
      patchRow(key, { replacing: false, replaceValue: "" });
      setToast({ kind: "ok", text: `Updated ${key}` });
      await refresh();
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    }
  }

 /** Delete flow — second click of the same row's button confirms. */
  async function handleDelete(key: string): Promise<void> {
    const cur = rowState[key];
    if (!cur?.confirmingDelete) {
 // First click: arm the confirm. Auto-disarm in 5s so a stray
 // click doesn't sit primed for the next session.
      patchRow(key, { confirmingDelete: true });
      window.setTimeout(() => {
        setRowState((prev) => {
          const r = prev[key];
          if (!r) return prev;
          return { ...prev, [key]: { ...r, confirmingDelete: false } };
        });
      }, 5000);
      return;
    }
 // Second click: actually delete.
    try {
      await invoke("vault_delete", { key });
 // Clear any inline state on this key — it's about to vanish.
      setRowState((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setToast({ kind: "ok", text: `Deleted ${key}` });
      await refresh();
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    }
  }

  const canAdd = addKey.trim().length > 0 && addValue.length > 0 && !adding;

  return (
    <div className="settings-tab-body vault-tab">
      <div className="vault-header">
        <KeyringBadge status={status} />
        <div className="vault-header-spacer" />
        <button
          type="button"
          className="settings-pill"
          onClick={() => void refresh()}
          disabled={busy}
          title="Reload key list"
        >
          {busy ? "…" : "Refresh"}
        </button>
      </div>

 {/* dedicated xAI key field.
 * Exposing the canonical path `xai/api-key` in the UI was wrong
 * UX — users shouldn't need to know the storage key name. This
 * row has its OWN labeled input that maps internally to
 * `xai/api-key`. Status reflects whether the canonical slot is
 * set; the generic add-row below stays for power-users adding
 * arbitrary keys.
 */}
      <XaiKeyRow
        present={!xaiMissing}
        onSave={async (value: string) => {
          try {
            await invoke("vault_set", { key: XAI_KEY, value });
            setToast({ kind: "ok", text: "xAI API key saved" });
            await refresh();
          } catch (e) {
            setToast({ kind: "err", text: formatErr(e) });
          }
        }}
      />

 {/* Top inline add-row. Always visible (no separate modal). */}
      <form
        className="vault-add-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (canAdd) void handleAdd();
        }}
        style={{
          display: "flex",
          gap: "var(--space-2)",
          alignItems: "center",
          padding: "var(--space-2) 0",
        }}
      >
        <input
          type="text"
          className="settings-input"
          placeholder="namespace/name (e.g. xai/api-key)"
          value={addKey}
          onChange={(e) => setAddKey(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-label="New secret key name"
          style={{ flex: 1 }}
        />
 {/* Always password type — value never displays in plaintext. */}
        <input
          type="password"
          className="settings-input"
          placeholder="value"
          value={addValue}
          onChange={(e) => setAddValue(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-label="New secret value"
          style={{ flex: 1 }}
        />
        <button
          type="submit"
          className={`settings-pill ${canAdd ? "active" : ""}`}
          disabled={!canAdd}
        >
          {adding ? "Saving…" : "Save"}
        </button>
      </form>

 {/* Toast / inline confirmation. We intentionally do NOT use
          alert() — see UX spec point 5. Errors surface red, successes
          surface green; both dismiss after 3s. */}
      {toast && (
        <div
          role={toast.kind === "err" ? "alert" : "status"}
          className="vault-error"
          style={{
            borderColor: toast.kind === "err" ? "#4a2a2a" : "#2a4a2a",
            background: toast.kind === "err" ? "#2a1818" : "#182a18",
            color: toast.kind === "err" ? "#d68a8a" : "#8bbf8b",
          }}
        >
          {toast.text}
          <button
            type="button"
            className="vault-error-dismiss"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            ✕
          </button>
        </div>
      )}

      <div className="vault-filter-row">
        <input
          type="text"
          className="settings-input"
          placeholder={`Filter ${keys.length} key${keys.length === 1 ? "" : "s"}…`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter vault keys"
        />
      </div>

      <div className="vault-list" role="list">
        {filtered.length === 0 ? (
          <div className="vault-empty">
            {keys.length === 0
              ? "Vault is empty. Add your first secret above."
              : "No matches."}
          </div>
        ) : (
          filtered.map((key) => {
            const r = rowState[key] ?? {
              replacing: false,
              replaceValue: "",
              confirmingDelete: false,
            };
            return (
              <VaultRow
                key={key}
                name={key}
                row={r}
                onStartReplace={() =>
                  patchRow(key, { replacing: true, replaceValue: "" })
                }
                onChangeReplaceValue={(v) => patchRow(key, { replaceValue: v })}
                onCancelReplace={() =>
                  patchRow(key, { replacing: false, replaceValue: "" })
                }
                onSubmitReplace={() => void handleReplace(key)}
                onDeleteClick={() => void handleDelete(key)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

/* ─────────────── Sub-components ─────────────── */

/**
 * OS-keyring custody badge. Same semantics as before surfaces
 * whether the master key for vault.enc lives in the OS keyring (good),
 * a fallback keyfile (acceptable), or nowhere (vault not yet init'd).
 */
function KeyringBadge({ status }: { status: VaultStatus | null }): JSX.Element {
  if (!status) {
    return <span className="vault-badge vault-badge-unknown">keyring: loading…</span>;
  }
  if (!status.initialized) {
    return <span className="vault-badge vault-badge-warn">keyring: not initialized</span>;
  }
  if (status.usingFallbackKeyfile) {
    return (
      <span
        className="vault-badge vault-badge-warn"
        title="OS keyring was unavailable — master key stored in ~/.shellx/vault.master.key (mode 0600)."
      >
        keyring: fallback-keyfile
      </span>
    );
  }
  if (status.keyringAvailable) {
    return (
      <span
        className="vault-badge vault-badge-ok"
        title="Master key stored in OS keyring (libsecret on Linux / Keychain on macOS / Credential Manager on Windows)."
      >
        keyring: ok
      </span>
    );
  }
  return <span className="vault-badge vault-badge-err">keyring: unavailable</span>;
}

/**
 * Single secret row. The row collapses into "name + actions" until the
 * user opts into replace, at which point an inline password input slides
 * in below. Delete uses two-click confirmation — first click arms,
 * second click within 5s actually deletes.
 */
function VaultRow({
  name,
  row,
  onStartReplace,
  onChangeReplaceValue,
  onCancelReplace,
  onSubmitReplace,
  onDeleteClick,
}: {
  name: string;
  row: RowState;
  onStartReplace: () => void;
  onChangeReplaceValue: (v: string) => void;
  onCancelReplace: () => void;
  onSubmitReplace: () => void;
  onDeleteClick: () => void;
}): JSX.Element {
  const canSubmitReplace = row.replaceValue.length > 0;
  return (
    <div className={`vault-row ${row.replacing ? "active" : ""}`} role="listitem">
      <div className="vault-row-head">
        <span className="vault-key-name" title={name}>
          {name}
        </span>
        <div className="vault-row-actions">
          {!row.replacing && (
            <button
              type="button"
              className="settings-pill vault-action-edit"
              onClick={onStartReplace}
              aria-label={`Replace value for ${name}`}
              title="Replace value"
            >
              ✎ Replace
            </button>
          )}
          <button
            type="button"
            className={`settings-pill vault-action-delete ${
              row.confirmingDelete ? "active" : ""
            }`}
            onClick={onDeleteClick}
            aria-label={
              row.confirmingDelete ? `Confirm delete ${name}` : `Delete ${name}`
            }
            title={row.confirmingDelete ? "Click again to confirm" : "Delete secret"}
          >
            {row.confirmingDelete ? "Delete?" : "🗑"}
          </button>
        </div>
      </div>
      {row.replacing && (
        <form
          className="vault-row-edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmitReplace) onSubmitReplace();
          }}
          style={{
            display: "flex",
            gap: "var(--space-2)",
            alignItems: "center",
            paddingTop: "var(--space-2)",
          }}
        >
          <input
            type="password"
            className="settings-input vault-value-input"
            placeholder="New value"
            value={row.replaceValue}
            onChange={(e) => onChangeReplaceValue(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoFocus
            aria-label={`New value for ${name}`}
            style={{ flex: 1 }}
          />
          <button
            type="submit"
            className={`settings-pill ${canSubmitReplace ? "active" : ""}`}
            disabled={!canSubmitReplace}
          >
            Save
          </button>
          <button type="button" className="settings-pill" onClick={onCancelReplace}>
            ✕
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * dedicated xAI key row.
 *
 * Users don't see / type the canonical path `xai/api-key` — they see
 * a labeled "xAI API Key" field with help text. Pressing Save maps
 * the value into the canonical slot under the hood. Shows a green
 * checkmark + ✎ Replace once a value is set; the actual value is
 * never displayed (vault rule: names only, no plaintext).
 */
function XaiKeyRow(props: {
  present: boolean;
  onSave: (value: string) => Promise<void>;
}): JSX.Element {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
 //  consume the previously-orphan voice_credential_source
 // Tauri command. Renders an honest "STT: ready (via OAuth)" /
 // "(via vault)" / "(no key)" badge next to the xAI row so the user
 // can see whether voice input will work without a round-trip test.
  const [credSource, setCredSource] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const src = await invoke<string>("voice_credential_source");
        if (!cancelled) setCredSource(src);
      } catch { /* browser-mode or command-missing — leave empty */ }
    })();
    return () => { cancelled = true; };
  }, [props.present]);
  const canSave = value.length > 0 && !saving;

  async function doSave(): Promise<void> {
    if (!canSave) return;
    setSaving(true);
    try {
      await props.onSave(value);
      setValue("");
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="xai-key-row"
      role="region"
      aria-label="xAI API Key"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "var(--space-3)",
        marginTop: "var(--space-2)",
        border: "1px solid var(--hairline-2)",
        borderRadius: 6,
        background: "var(--surface-2)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-2)",
        }}
      >
        <div>
 {/* inline fontSize: 13/11 dropped
 * in favor of class-scoped sizing. Heading-class
 * .settings-row-heading = 13px medium-weight; secondary
 * description inherits 12px from .settings-tab-hint. */}
          <div className="settings-row-heading">
            xAI API Key <span style={{ opacity: 0.6, fontWeight: 400, fontSize: "var(--fs-ui-xs)", marginLeft: 6 }}>(optional)</span>
            {props.present && (
              <span style={{ marginLeft: 8, color: "#7fb482" }} aria-label="set">
                ✓ set
              </span>
            )}
            {credSource && credSource !== "none" && (
              <span
                style={{ marginLeft: 8, fontSize: "var(--fs-ui-xs)", color: "#7fb482", fontWeight: 400 }}
                title={`STT credential source: ${credSource}`}
              >
                · STT ready ({credSource})
              </span>
            )}
            {credSource === "none" && (
              <span
                style={{ marginLeft: 8, fontSize: "var(--fs-ui-xs)", color: "#d97757", fontWeight: 400 }}
                title="No xAI credential found — STT will fail until grok login is run or a key is added"
              >
                · STT no credential
              </span>
            )}
          </div>
          <div className="settings-tab-hint" style={{ margin: "2px 0 0" }}>
            Voice (STT) and vision use your grok-build OAuth token by default —
            <strong> no key needed</strong> if you've run <code>grok login</code>.
            Add a key here only if you want to bill a different xAI account or test
            with a developer key. Get one at{" "}
            <a
              href="https://console.x.ai"
              target="_blank"
              rel="noreferrer"
              style={{ color: "inherit", textDecoration: "underline" }}
            >
              console.x.ai
            </a>
            .
          </div>
        </div>
        {props.present && !editing && (
          <button
            type="button"
            className="settings-pill"
            onClick={() => setEditing(true)}
          >
            ✎ Replace
          </button>
        )}
      </div>

      {(!props.present || editing) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void doSave();
          }}
          style={{
            display: "flex",
            gap: "var(--space-2)",
            alignItems: "center",
          }}
        >
          <input
            type="password"
            className="settings-input"
            placeholder="Paste your xAI key (xai-…)"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label="xAI API key value"
            autoFocus={editing}
            style={{ flex: 1 }}
          />
          <button
            type="submit"
            className={`settings-pill ${canSave ? "active" : ""}`}
            disabled={!canSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {editing && (
            <button
              type="button"
              className="settings-pill"
              onClick={() => {
                setValue("");
                setEditing(false);
              }}
            >
              ✕
            </button>
          )}
        </form>
      )}
    </div>
  );
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
