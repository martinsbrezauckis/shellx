/**
 * src/components/PluginsModal.tsx — Plugins management modal.
 *
 * Sections:
 *   1. Built-in — shellx-host MCP on/off toggle.
 *   2. Marketplace — Tier S/A/B/C with per-entry Enable/Remove +
 *      Enable/Disable. Vault-aware: rows whose required keys aren't in
 *      the vault show "key needed".
 *
 * Grok-native config: installs write managed `shellx-mp-*` entries into
 * `~/.grok/config.toml`; grok owns MCP discovery/list/doctor at session
 * start. shellx-host toggle still stays built-in and shellX-managed.
 *
 * Backend Tauri commands (src-tauri/src/mcp_marketplace.rs):
 *   - mcp_marketplace_list → McpEntryStatus[]
 *   - mcp_marketplace_install(id) — adds/enables the managed config entry
 *   - mcp_marketplace_uninstall(id)
 *   - mcp_marketplace_set_enabled(id, enabled)
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../lib/tauri-bridge";
import { ShellIcon } from "./icons";

type McpKind = "stdio" | "http" | "sse";
type McpTier = "s" | "a" | "b" | "c";

interface McpEntryStatus {
  id: string;
  name: string;
  tier: McpTier;
  kind: McpKind;
  description: string;
  category: string;
  vaultKeys: string[];
  installed: boolean;
  enabled: boolean;
  keysAvailable: boolean[];
  allKeysPresent: boolean;
}

const TIER_TITLES: Record<McpTier, string> = {
  s: "Recommended",
  a: "With key",
  b: "Specialty",
  c: "Advanced",
};

const TIER_HINT: Record<McpTier, string> = {
  s: "Zero-config tools — enable in one click",
  a: "One vault key — high payoff",
  b: "Niche tools for specific stacks",
  c: "Databases, infra, OAuth-heavy connectors",
};

// Tier C is collapsed by default to keep the modal small. Other tiers
// always render expanded (the proposal has them visible upfront).
const DEFAULT_COLLAPSED: Set<McpTier> = new Set<McpTier>(["c"]);

export function PluginsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
  /** Kept for caller compatibility. Session-scoped tool health now
   *  lives in the right-rail Tooling tab, not this global modal. */
  activeTabId?: string | null;
}): JSX.Element | null {
  // Esc-to-close. Click outside is handled by the backdrop's onClick.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // ─── shellx-host (built-in) toggle state ──────────────────────────
  const [hostMcpEnabled, setHostMcpEnabled] = useState<boolean>(true);
  const [hostMcpStatus, setHostMcpStatus] = useState<"idle" | "loading" | "error">("idle");
  const [hostMcpError, setHostMcpError] = useState<string | null>(null);

  // ─── marketplace state ────────────────────────────────────────────
  const [marketplace, setMarketplace] = useState<McpEntryStatus[]>([]);
  const [mpLoading, setMpLoading] = useState<boolean>(false);
  const [mpError, setMpError] = useState<string | null>(null);
  const [collapsedTiers, setCollapsedTiers] = useState<Set<McpTier>>(DEFAULT_COLLAPSED);
  // Per-id ephemeral pending state — disables the action button while a
  // Tauri call is in flight so users can't double-click into an install
  // race.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const refetchMarketplace = useCallback(async () => {
    if (!inTauri()) return;
    setMpLoading(true);
    setMpError(null);
    try {
      const list = await invoke<McpEntryStatus[]>("mcp_marketplace_list");
      setMarketplace(list);
    } catch (err) {
      setMpError(typeof err === "string" ? err : String(err));
    } finally {
      setMpLoading(false);
    }
  }, []);

  // Fetch host MCP state + marketplace list on modal open.
  useEffect(() => {
    if (!open) return;
    if (!inTauri()) return;
    let cancelled = false;
    setHostMcpStatus("loading");
    setHostMcpError(null);
    void (async () => {
      try {
        const cur = await invoke<boolean>("read_host_mcp_enabled");
        if (cancelled) return;
        setHostMcpEnabled(cur);
        setHostMcpStatus("idle");
      } catch (err) {
        if (cancelled) return;
        setHostMcpEnabled(true);
        setHostMcpStatus("error");
        setHostMcpError(typeof err === "string" ? err : String(err));
      }
    })();
    void refetchMarketplace();
    return () => {
      cancelled = true;
    };
  }, [open, refetchMarketplace]);

  const onToggleHostMcp = useCallback(async (next: boolean) => {
    if (!inTauri()) return;
    setHostMcpStatus("loading");
    setHostMcpError(null);
    try {
      const result = await invoke<boolean>("set_host_mcp_enabled", { enabled: next });
      setHostMcpEnabled(result);
      setHostMcpStatus("idle");
    } catch (err) {
      setHostMcpStatus("error");
      setHostMcpError(typeof err === "string" ? err : String(err));
    }
  }, []);

  // Generic Tauri-call wrapper that flips pending state + refetches.
  const runMpAction = useCallback(
    async (id: string, cmd: string, extra?: Record<string, unknown>) => {
      if (!inTauri()) return;
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      try {
        await invoke<void>(cmd, { id, ...(extra ?? {}) });
        await refetchMarketplace();
      } catch (err) {
        setMpError(typeof err === "string" ? err : String(err));
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [refetchMarketplace],
  );

  // ─── derived: marketplace grouped by tier ─────────────────────────
  const tiers = useMemo<Record<McpTier, McpEntryStatus[]>>(() => {
    const out: Record<McpTier, McpEntryStatus[]> = { s: [], a: [], b: [], c: [] };
    for (const e of marketplace) {
      out[e.tier].push(e);
    }
    return out;
  }, [marketplace]);

  // First-run helper: show "Enable Recommended" hero if nothing in
  // Tier S has been enabled yet.
  const tierSAllInstalled = tiers.s.length > 0 && tiers.s.every((e) => e.installed);
  const tierSNoneInstalled = tiers.s.length > 0 && tiers.s.every((e) => !e.installed);

  const installTierSDefaults = useCallback(async () => {
    if (!inTauri()) return;
    for (const e of tiers.s) {
      if (!e.installed) {
        try {
          await invoke<void>("mcp_marketplace_install", { id: e.id });
        } catch {
          // ignore individual failures — re-fetch will show what made it
        }
      }
    }
    await refetchMarketplace();
  }, [tiers.s, refetchMarketplace]);

  const toggleTier = useCallback((tier: McpTier) => {
    setCollapsedTiers((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
  }, []);

  if (!open) return null;

  return (
    <div className="pmodal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Plugins">
      <div className="pmodal plugins-modal" onClick={(e) => e.stopPropagation()}>
        <header className="pmodal-hdr">
          <span className="pmodal-title">Plugins</span>
          <span className="pmodal-sub">MCP servers, connectors, skills</span>
          <button className="pmodal-x" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <ShellIcon name="close" size={14} />
          </button>
        </header>

        <div className="pmodal-body">
          {/* ─── Built-in: shellx-host ──────────────────────────── */}
          <section className="pmodal-section">
            <h3 className="pmodal-section-hdr">
              Built-in <span className="ct">· 1</span>
            </h3>
            <div className="mp-list">
              <div className="mp-row">
                <div className="mp-row-main">
                  <span className="mp-name">shellx-host</span>
                  <span className="mp-kind mp-kind-mcp">MCP</span>
                  <span className="mp-status mp-status-builtin">
                    <ShellIcon name="plug" size={11} />
                    built-in
                  </span>
                </div>
                <p className="mp-desc">Native fs / process / screenshot / vault / Agent / mem tools.</p>
                <div className="mp-row-foot">
                  <span className="mp-source">from ~/.grok/config.toml</span>
                  <label className="plugin-toggle">
                    <input
                      type="checkbox"
                      checked={hostMcpEnabled}
                      disabled={hostMcpStatus === "loading"}
                      onChange={(e) => void onToggleHostMcp(e.target.checked)}
                    />
                    <span className="plugin-toggle-track">
                      <span className="plugin-toggle-thumb" />
                    </span>
                    <span className="plugin-toggle-lbl">{hostMcpEnabled ? "Enabled" : "Disabled"}</span>
                  </label>
                </div>
                <div className="plugin-row-hint">
                  {hostMcpStatus === "error" && hostMcpError ? (
                    <span className="plugin-row-hint-err">{hostMcpError}</span>
                  ) : (
                    <span className="plugin-row-hint-info">
                      Restart grok session for the change to take effect.
                    </span>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* ─── First-run hero ─────────────────────────────────── */}
          {tierSNoneInstalled && (
            <section className="pmodal-section mp-hero">
              <div className="mp-hero-text">
                <strong>First time?</strong> Enable the {tiers.s.length} recommended zero-config connectors —
                Context7, Playwright, Fetch, Git, Memory. No keys required.
              </div>
              <button
                className="mp-action-btn mp-action-btn-primary"
                onClick={() => void installTierSDefaults()}
                disabled={mpLoading}
              >
                Enable Recommended
              </button>
            </section>
          )}

          {/* ─── Marketplace error banner (only on failure) ─────── */}
          {mpError && (
            <section className="pmodal-section">
              <div className="plugin-row-hint-err" style={{ padding: 10 }}>
                Marketplace: {mpError}
              </div>
            </section>
          )}

          {/* ─── Tier sections ─────────────────────────────────── */}
          {(["s", "a", "b", "c"] as McpTier[]).map((tier) => {
            const list = tiers[tier];
            if (list.length === 0) return null;
            const collapsed = collapsedTiers.has(tier);
            const installedCount = list.filter((e) => e.installed).length;
            return (
              <section key={tier} className="pmodal-section mp-tier-section">
                <h3
                  className="pmodal-section-hdr mp-tier-hdr"
                  onClick={() => toggleTier(tier)}
                  style={{ cursor: "pointer" }}
                  title={collapsed ? "Click to expand" : "Click to collapse"}
                >
                  <span className="mp-tier-toggle">
                    <ShellIcon name={collapsed ? "chevron-right" : "chevron-down"} size={13} />
                  </span>
                  {TIER_TITLES[tier]}
                  <span className="ct">
                    · {installedCount}/{list.length}
                  </span>
                  <span className="mp-tier-hint">{TIER_HINT[tier]}</span>
                </h3>
                {!collapsed && (
                  <div className="mp-list">
                    {list.map((e) => (
                      <MarketplaceRow
                        key={e.id}
                        entry={e}
                        pending={pendingIds.has(e.id)}
                        onInstall={() => void runMpAction(e.id, "mcp_marketplace_install")}
                        onUninstall={() => void runMpAction(e.id, "mcp_marketplace_uninstall")}
                        onSetEnabled={(en) =>
                          void runMpAction(e.id, "mcp_marketplace_set_enabled", { enabled: en })
                        }
                        onRefresh={refetchMarketplace}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}

          {/* ─── Loading shimmer (only on initial fetch) ─────── */}
          {mpLoading && marketplace.length === 0 && (
            <section className="pmodal-section">
              <p className="pmodal-empty">Loading marketplace…</p>
            </section>
          )}
        </div>

        <footer className="pmodal-foot">
          <span style={{ color: "var(--ink-4)", fontSize: "var(--fs-ui-xs)", letterSpacing: "0.14em", textTransform: "uppercase" }}>
            {tierSAllInstalled ? "Recommended set enabled" : "Esc to close"}
          </span>
        </footer>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Single marketplace entry row.

function MarketplaceRow({
  entry,
  pending,
  onInstall,
  onUninstall,
  onSetEnabled,
  onRefresh,
}: {
  entry: McpEntryStatus;
  pending: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onSetEnabled: (enabled: boolean) => void;
  /** Refetches marketplace status after a vault write so the row
   *  re-evaluates `allKeysPresent` and the Add-key form collapses. */
  onRefresh: () => Promise<void> | void;
}): JSX.Element {
  const needsKey = entry.vaultKeys.length > 0 && !entry.allKeysPresent;
  // Inline key entry form. Each missing key gets its own
  // password-style input + Save button. Avoids the cross-window jump
  // that the previous "Open Settings → Vault" CTA forced. State is
  // keyed by the canonical vault path (e.g. "openai/api-key") so each
  // input is independent.
  const [adding, setAdding] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveKey = useCallback(async (k: string) => {
    const v = values[k];
    if (!v) return;
    setSaving(k);
    setError(null);
    try {
      await invoke("vault_set", { key: k, value: v });
      setValues((prev) => ({ ...prev, [k]: "" }));
      setSavedFlash(k);
      window.setTimeout(() => setSavedFlash(null), 1200);
      await onRefresh();
    } catch (e: unknown) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setSaving(null);
    }
  }, [values, onRefresh]);

  let statusPill: JSX.Element;
  if (entry.installed && !entry.enabled) {
    statusPill = (
      <span className="mp-status mp-status-disabled">
        <ShellIcon name="ban" size={11} />
        disabled
      </span>
    );
  } else if (needsKey) {
    statusPill = (
      <span className="mp-status mp-status-keyneeded">
        <ShellIcon name="lock" size={11} />
        key needed
      </span>
    );
  } else if (entry.installed && entry.enabled) {
    statusPill = (
      <span className="mp-status mp-status-ready">
        <ShellIcon name="circle-check" size={11} />
        enabled
      </span>
    );
  } else {
    statusPill = (
      <span className="mp-status mp-status-available">
        <ShellIcon name="plus" size={11} />
        available
      </span>
    );
  }

  let action: JSX.Element;
  if (entry.installed) {
    action = (
      <div className="mp-row-actions">
        {needsKey && (
          <button
            className="mp-action-btn mp-action-btn-primary"
            onClick={() => {
              setAdding((v) => {
                if (v) {
                  setValues((prev) => {
                    const next = { ...prev };
                    entry.vaultKeys.forEach((k) => { delete next[k]; });
                    return next;
                  });
                  setError(null);
                }
                return !v;
              });
            }}
            title={adding ? "Cancel adding key (clears input)" : "Enter your API key inline"}
          >
            {adding ? "Cancel" : "Add key"}
          </button>
        )}
        <label className="plugin-toggle plugin-toggle-compact">
          <input
            type="checkbox"
            checked={entry.enabled}
            disabled={pending}
            onChange={(e) => onSetEnabled(e.target.checked)}
          />
          <span className="plugin-toggle-track">
            <span className="plugin-toggle-thumb" />
          </span>
          <span className="plugin-toggle-lbl">{entry.enabled ? "On" : "Off"}</span>
        </label>
        <button className="mp-action-btn mp-action-btn-secondary" onClick={onUninstall} disabled={pending}>
          Remove
        </button>
      </div>
    );
  } else if (needsKey) {
    action = (
      <div className="mp-row-actions">
        <button
          className="mp-action-btn mp-action-btn-primary"
          onClick={() => {
            setAdding((v) => {
              // Wipe entered key values when Cancel is pressed. Without
              // this, a Cancel + re-open of the form re-shows the prior
              // plaintext key in the input, which is both a privacy
              // surprise and increases the window for shoulder-surfing.
              if (v) {
                setValues((prev) => {
                  const next = { ...prev };
                  entry.vaultKeys.forEach((k) => { delete next[k]; });
                  return next;
                });
                setError(null);
              }
              return !v;
            });
          }}
          title={adding ? "Cancel adding key (clears input)" : "Enter your API key inline"}
        >
          {adding ? "Cancel" : "Add key"}
        </button>
        <button className="mp-action-btn mp-action-btn-secondary" onClick={onInstall} disabled={pending}>
          {pending ? "Enabling…" : "Enable anyway"}
        </button>
      </div>
    );
  } else {
    action = (
      <div className="mp-row-actions">
        <button className="mp-action-btn mp-action-btn-primary" onClick={onInstall} disabled={pending}>
          {pending ? "Enabling…" : "Enable"}
        </button>
      </div>
    );
  }

  return (
    <div className="mp-row">
      <div className="mp-row-main">
        <span className="mp-name">{entry.name}</span>
        <span className={`mp-kind mp-kind-${entry.kind}`}>{entry.kind.toUpperCase()}</span>
        {statusPill}
      </div>
      <p className="mp-desc">{entry.description}</p>
      {needsKey && (
        <p className="mp-vault-hint">
          Needs vault key{entry.vaultKeys.length > 1 ? "s" : ""}:{" "}
          {entry.vaultKeys.map((k, i) => (
            <code key={k}>
              {k}
              {!entry.keysAvailable[i] ? " (missing)" : ""}
              {i < entry.vaultKeys.length - 1 ? ", " : ""}
            </code>
          ))}
        </p>
      )}
      {needsKey && adding && (
        <div
          className="mp-key-form"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            margin: "6px 0 4px",
            padding: 10,
            background: "var(--surface-2, rgba(255,255,255,0.03))",
            border: "1px solid var(--hairline, rgba(255,255,255,0.08))",
            borderRadius: 6,
          }}
        >
          {entry.vaultKeys.map((k, i) => {
            const isPresent = !!entry.keysAvailable[i];
            return (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <code style={{ minWidth: 160, fontSize: 12, opacity: 0.75 }}>{k}</code>
                <input
                  type="password"
                  value={values[k] ?? ""}
                  onChange={(e) => setValues((prev) => ({ ...prev, [k]: e.target.value }))}
                  placeholder={isPresent ? "(already set — overwrite)" : "Paste API key value"}
                  autoComplete="off"
                  spellCheck={false}
                  style={{
                    flex: 1,
                    background: "var(--surface, rgba(0,0,0,0.4))",
                    color: "var(--ink)",
                    border: "1px solid var(--hairline, rgba(255,255,255,0.12))",
                    borderRadius: 4,
                    padding: "4px 8px",
                    font: "12px var(--mono, monospace)",
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") void saveKey(k); }}
                />
                <button
                  type="button"
                  className="mp-action-btn mp-action-btn-secondary"
                  onClick={() => void saveKey(k)}
                  disabled={!values[k] || saving === k}
                  style={{ minWidth: 60 }}
                >
                  {saving === k
                    ? "..."
                    : savedFlash === k
                      ? <ShellIcon name="check" size={13} />
                      : "Save"}
                </button>
              </div>
            );
          })}
          {error && (
            <div style={{ color: "#d97757", fontSize: "var(--fs-ui-xs)", padding: "2px 4px" }}>
              {error}
            </div>
          )}
          <div style={{ fontSize: "var(--fs-ui-xs)", opacity: 0.6, padding: "0 4px" }}>
            Stored in your local vault — passed to Grok only as a process env var.
          </div>
        </div>
      )}
      <div className="mp-row-foot">{action}</div>
    </div>
  );
}
