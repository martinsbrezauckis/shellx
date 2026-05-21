/**
 * src/components/VaultPanel.tsx — local secrets vault management UI
 * .
 *
 * Mount in <PopoverRoot> behind a small "vault" entry in Settings or
 * a ⌘. shortcut. Until then, the component is importable but NOT
 * mounted in App.tsx — agent J's UI-polish work will mount it once
 * the layout converges.
 *
 * UX rules:
 * - The list shows KEYS only. Values are never paged into the view.
 * - "Reveal" surfaces a transient modal that calls vault_get(key)
 * on click, copies-to-clipboard, then clears the value on close.
 * - Values entered in the "Add" form are masked while typing; on
 * submit the field is cleared so a returning user doesn't see
 * the last-typed secret.
 * - Empty-key, traversal-pattern, or oversized keys are rejected
 * server-side. The component surfaces the error message inline.
 *
 * Backend wiring:
 * - invoke("vault_list_keys", {prefix?}) → string[]
 * - invoke("vault_get", {key}) → string | null
 * - invoke("vault_set", {key,value})
 * - invoke("vault_delete", {key})
 * - invoke("vault_status") → { initialized, keyringAvailable,
 * usingFallbackKeyfile, keyCount }
 *
 * Constraint: no logging the value, no toast that echoes the value.
 * The reveal modal is the only path to plaintext, and it clears on
 * close.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";

interface VaultStatus {
  initialized: boolean;
  keyringAvailable: boolean;
  usingFallbackKeyfile: boolean;
  keyCount: number;
}

export function VaultPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const [keys, setKeys] = useState<string[]>([]);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
 // Add-form state.
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [adding, setAdding] = useState(false);
 // Reveal modal — holds the value ONLY while open.
  const [revealKey, setRevealKey] = useState<string | null>(null);
  const [revealValue, setRevealValue] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [k, s] = await Promise.all([
        invoke<string[]>("vault_list_keys", { prefix: null }),
        invoke<VaultStatus>("vault_status"),
      ]);
      setKeys(k);
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) {
      refresh();
    }
  }, [open, refresh]);

 // When the reveal modal closes (parent click, esc, etc), wipe the
 // cached plaintext so a subsequent React render can't show it.
  useEffect(() => {
    if (revealKey === null) {
      setRevealValue(null);
    }
  }, [revealKey]);

  if (!open) return null;

  const filtered = keys.filter((k) => k.toLowerCase().includes(filter.toLowerCase()));

  async function handleAdd() {
    if (!newKey.trim()) {
      setError("key cannot be empty");
      return;
    }
    setAdding(true);
    try {
      await invoke("vault_set", { key: newKey.trim(), value: newValue });
      setNewKey("");
      setNewValue("");
      setError(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(key: string) {
    if (!window.confirm(`Delete vault key "${key}"?`)) return;
    try {
      await invoke("vault_delete", { key });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleReveal(key: string) {
    setRevealKey(key);
    try {
      const v = await invoke<string | null>("vault_get", { key });
      setRevealValue(v);
    } catch (e) {
      setError(String(e));
      setRevealKey(null);
    }
  }

  function closeReveal() {
    setRevealKey(null);
    setRevealValue(null);
  }

  async function copyRevealed() {
    if (!revealValue) return;
    try {
      await navigator.clipboard.writeText(revealValue);
    } catch {
 // Clipboard API failure is non-fatal; the user still has the
 // modal text visible to copy manually.
    }
  }

  return (
    <div
      className="vault-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vault-title"
      onClick={onClose}
    >
      <div
        className="vault-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: 560,
          maxHeight: "80vh",
          background: "var(--bg-elev, #111)",
          color: "var(--fg, #eee)",
          border: "1px solid var(--border, #333)",
          borderRadius: 8,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          zIndex: 999,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 id="vault-title" style={{ margin: 0, fontSize: 18 }}>
            Local Vault
          </h2>
          <button onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {status && (
          <div style={{ fontSize: 12, color: "var(--fg-muted, #888)" }}>
            {status.keyCount} key{status.keyCount === 1 ? "" : "s"}
            {" · "}
            {status.keyringAvailable
              ? "OS keyring"
              : status.usingFallbackKeyfile
                ? "Fallback keyfile (~/.shellx/vault.master.key)"
                : "Uninitialized"}
          </div>
        )}
        {error && (
          <div role="alert" style={{ color: "var(--fg-error, #f55)", fontSize: "var(--fs-ui-sm)" }}>
            {error}
          </div>
        )}
        <input
          type="text"
          placeholder="Filter keys…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ padding: 6, background: "transparent", border: "1px solid #333", color: "inherit" }}
        />
        <div
          style={{
            flex: "1 1 auto",
            minHeight: 100,
            maxHeight: 240,
            overflowY: "auto",
            border: "1px solid var(--border, #333)",
            borderRadius: 4,
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: 16, fontSize: "var(--fs-ui-sm)", color: "var(--fg-muted, #888)" }}>
              {keys.length === 0 ? "Vault is empty." : "No matches."}
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {filtered.map((k) => (
                <li
                  key={k}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "6px 12px",
                    borderBottom: "1px solid var(--border, #222)",
                  }}
                >
                  <span style={{ fontFamily: "var(--mono, monospace)", fontSize: "var(--fs-ui-sm)" }}>{k}</span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => handleReveal(k)}>Show</button>
                    <button onClick={() => handleDelete(k)}>Delete</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div style={{ borderTop: "1px solid var(--border, #333)", paddingTop: 12 }}>
          <div style={{ fontSize: 12, color: "var(--fg-muted, #888)", marginBottom: 6 }}>
            Add a value (keys use [a-zA-Z0-9._/-]; values capped at 64KB):
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              placeholder="key (e.g. user.openai_api_key)"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              style={{ flex: 2, padding: 6, background: "transparent", border: "1px solid #333", color: "inherit" }}
            />
            <input
              type="password"
              placeholder="value (hidden while typing)"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              style={{ flex: 3, padding: 6, background: "transparent", border: "1px solid #333", color: "inherit" }}
            />
            <button onClick={handleAdd} disabled={adding}>
              {adding ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
      {revealKey !== null && (
        <div
          className="vault-reveal"
          role="dialog"
          aria-modal="true"
          onClick={closeReveal}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg-elev, #1a1a1a)",
              border: "1px solid var(--border, #333)",
              borderRadius: 8,
              padding: 20,
              minWidth: 420,
              maxWidth: 600,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <strong style={{ fontFamily: "var(--mono, monospace)" }}>{revealKey}</strong>
            <textarea
              readOnly
              value={revealValue ?? "(loading…)"}
              rows={6}
              style={{
                fontFamily: "var(--mono, monospace)",
                fontSize: "var(--fs-ui-sm)",
                background: "transparent",
                border: "1px solid #333",
                color: "inherit",
                resize: "none",
                padding: 6,
              }}
            />
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button onClick={copyRevealed} disabled={!revealValue}>
                Copy
              </button>
              <button onClick={closeReveal}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
