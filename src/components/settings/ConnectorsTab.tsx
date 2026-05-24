/**
 * Settings -> Connectors.
 *
 * Outside connectors are user-facing channels such as Telegram bots
 * and local bridge relays. This first slice manages config and tests
 * credentials; runtime ingestion is intentionally review-first work
 * that follows once users can see routing rules clearly.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { apiGet } from "../../lib/debug-api";
import { inTauri } from "../../lib/tauri-bridge";

type ProviderKind = "telegram" | "generic_relay";
type DispatchMode = "inbox" | "autoPrompt";

interface TelegramProvider {
  kind: "telegram";
  botTokenVaultKey: string;
  allowedChatIds: string[];
}

interface GenericRelayProvider {
  kind: "generic_relay";
  sharedSecretVaultKey: string;
  allowedSenderIds: string[];
}

type ConnectorProvider = TelegramProvider | GenericRelayProvider;

type ConnectorTarget =
  | { mode: "activeTab" }
  | { mode: "fixedTab"; tabId: string };

interface OutsideConnector {
  id: string;
  label: string;
  enabled: boolean;
  provider: ConnectorProvider;
  target: ConnectorTarget;
  dispatchMode: DispatchMode;
  requireApproval: boolean;
  createdMs: number;
  updatedMs: number;
  lastTestMs?: number | null;
  lastError?: string | null;
}

interface ConnectorTestResult {
  reachable: boolean;
  provider: string;
  latencyMs?: number | null;
  identity?: string | null;
  error?: string | null;
}

interface LiveSession {
  tabId: string;
  title?: string | null;
  sessionId?: string | null;
  cwd?: string | null;
  hasActiveChild?: boolean;
  isSsh?: boolean;
  isWsl?: boolean;
  sshHost?: string | null;
  wslDistro?: string | null;
}

interface LiveSessionsResponse {
  tabs?: Array<Partial<LiveSession>>;
}

interface StoredTabRef {
  tabId: string;
  title?: string | null;
}

type Toast = { kind: "ok" | "err"; text: string } | null;

interface FormState {
  id: string;
  label: string;
  providerKind: ProviderKind;
  enabled: boolean;
  targetMode: "activeTab" | "fixedTab";
  fixedTabId: string;
  dispatchMode: DispatchMode;
  requireApproval: boolean;
  vaultKey: string;
  secretValue: string;
  allowedIdsText: string;
  createdMs: number;
  updatedMs: number;
}

const DEFAULT_TELEGRAM_KEY = "telegram/bot-token";
const DEFAULT_RELAY_KEY = "connectors/relay-secret";

export function ConnectorsTab(): JSX.Element {
  const [connectors, setConnectors] = useState<OutsideConnector[]>([]);
  const [vaultKeys, setVaultKeys] = useState<string[]>([]);
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [form, setForm] = useState<FormState>(() => emptyForm("telegram"));
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  const refresh = useCallback(async () => {
    if (!inTauri()) {
      setToast({ kind: "err", text: "Connectors unavailable outside Tauri." });
      return;
    }
    setBusy(true);
    try {
      const [list, keys, liveSessions] = await Promise.all([
        invoke<OutsideConnector[]>("outside_connectors_list"),
        invoke<string[]>("vault_list_keys", { prefix: null }),
        apiGet<LiveSessionsResponse>("/state/sessions")
          .then((r) => normalizeLiveSessions(r.tabs ?? [], readStoredTabOrder()))
          .catch(() => []),
      ]);
      setConnectors([...list].sort((a, b) => a.label.localeCompare(b.label)));
      setVaultKeys([...keys].sort((a, b) => a.localeCompare(b)));
      setSessions(liveSessions);
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const editing = form.id.trim().length > 0;
  const selectedSession = useMemo(
    () => sessions.find((session) => session.tabId === form.fixedTabId) ?? null,
    [sessions, form.fixedTabId],
  );
  const canSave = form.label.trim().length > 0
    && form.vaultKey.trim().length > 0
    && (form.targetMode !== "fixedTab" || form.fixedTabId.trim().length > 0)
    && !saving;
  const providerHelp = useMemo(() => {
    if (form.providerKind === "telegram") {
      return "Telegram uses BotFather token + allowed chat IDs. Runtime will show numbered /sessions results, then /use 2 or /use <tabId> binds a chat.";
    }
    return "Generic relay is the bridge path for WhatsApp, Discord, LAN tools, or a custom daemon. The bridge signs requests with the shared secret.";
  }, [form.providerKind]);

  async function handleSave(): Promise<void> {
    if (!canSave) return;
    setSaving(true);
    try {
      const vaultKey = form.vaultKey.trim();
      if (form.secretValue.trim()) {
        await invoke("vault_set", { key: vaultKey, value: form.secretValue.trim() });
      }
      const connector: OutsideConnector = {
        id: form.id,
        label: form.label.trim(),
        enabled: form.enabled,
        provider: form.providerKind === "telegram"
          ? {
              kind: "telegram",
              botTokenVaultKey: vaultKey,
              allowedChatIds: splitIds(form.allowedIdsText),
            }
          : {
              kind: "generic_relay",
              sharedSecretVaultKey: vaultKey,
              allowedSenderIds: splitIds(form.allowedIdsText),
            },
        target: form.targetMode === "activeTab"
          ? { mode: "activeTab" }
          : { mode: "fixedTab", tabId: form.fixedTabId.trim() },
        dispatchMode: form.dispatchMode,
        requireApproval: form.requireApproval,
        createdMs: form.createdMs,
        updatedMs: form.updatedMs,
        lastTestMs: null,
        lastError: null,
      };
      const saved = await invoke<OutsideConnector>("outside_connectors_save", { connector });
      setToast({ kind: "ok", text: `Saved ${saved.label}` });
      setForm(emptyForm(saved.provider.kind));
      await refresh();
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(connector: OutsideConnector): Promise<void> {
    setTestingId(connector.id);
    try {
      const result = await invoke<ConnectorTestResult>("outside_connectors_test", { id: connector.id });
      if (result.reachable) {
        setToast({
          kind: "ok",
          text: `${connector.label}: ${result.identity ?? "reachable"}${result.latencyMs ? ` in ${result.latencyMs}ms` : ""}`,
        });
      } else {
        setToast({ kind: "err", text: `${connector.label}: ${result.error ?? "test failed"}` });
      }
      await refresh();
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    } finally {
      setTestingId(null);
    }
  }

  async function handleDelete(connector: OutsideConnector): Promise<void> {
    if (!window.confirm(`Delete connector "${connector.label}"?`)) return;
    try {
      await invoke("outside_connectors_delete", { id: connector.id });
      if (form.id === connector.id) setForm(emptyForm(connector.provider.kind));
      setToast({ kind: "ok", text: `Deleted ${connector.label}` });
      await refresh();
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    }
  }

  return (
    <div className="settings-tab-body connectors-tab">
      <div className="connectors-header">
        <p className="settings-tab-hint">
          Outside channels connect people and relays to shellX. Keep new
          connectors in Inbox mode until you trust the source and routing.
        </p>
        <button type="button" className="settings-pill" onClick={() => void refresh()} disabled={busy}>
          {busy ? "…" : "Refresh"}
        </button>
      </div>

      {toast && <div role="status" className={`connector-toast connector-toast-${toast.kind}`}>{toast.text}</div>}

      <section className="connector-editor" aria-label="Connector editor">
        <div className="connector-editor-head">
          <h3>{editing ? "Edit connector" : "New connector"}</h3>
          {editing && (
            <button type="button" className="settings-pill" onClick={() => setForm(emptyForm(form.providerKind))}>
              New
            </button>
          )}
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="connector-label">Label</label>
          <input
            id="connector-label"
            className="settings-input"
            value={form.label}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            placeholder="Personal Telegram"
          />
          <label className="settings-check">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            Enabled
          </label>
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="connector-provider">Provider</label>
          <select
            id="connector-provider"
            className="settings-select"
            value={form.providerKind}
            onChange={(e) => {
              const providerKind = e.target.value as ProviderKind;
              setForm((f) => ({
                ...f,
                providerKind,
                vaultKey: providerKind === "telegram" ? DEFAULT_TELEGRAM_KEY : DEFAULT_RELAY_KEY,
                allowedIdsText: "",
                secretValue: "",
              }));
            }}
          >
            <option value="telegram">Telegram bot</option>
            <option value="generic_relay">Generic relay</option>
          </select>
          <span className="settings-suffix">{form.providerKind === "telegram" ? "native" : "bridge"}</span>
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="connector-vault-key">
            {form.providerKind === "telegram" ? "Bot token key" : "Shared secret key"}
          </label>
          <VaultKeyInput
            id="connector-vault-key"
            value={form.vaultKey}
            keys={vaultKeys}
            onChange={(vaultKey) => setForm((f) => ({ ...f, vaultKey }))}
          />
          <span className="settings-suffix">Vault</span>
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="connector-secret">
            {form.providerKind === "telegram" ? "Bot token" : "Shared secret"}
          </label>
          <input
            id="connector-secret"
            className="settings-input"
            type="password"
            value={form.secretValue}
            onChange={(e) => setForm((f) => ({ ...f, secretValue: e.target.value }))}
            placeholder="optional: paste to save/replace vault value"
            autoComplete="off"
          />
          <span className="settings-suffix">write only</span>
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="connector-allowed">
            {form.providerKind === "telegram" ? "Allowed chats" : "Allowed senders"}
          </label>
          <input
            id="connector-allowed"
            className="settings-input"
            value={form.allowedIdsText}
            onChange={(e) => setForm((f) => ({ ...f, allowedIdsText: e.target.value }))}
            placeholder={form.providerKind === "telegram" ? "123456789, -1001234567890" : "discord:me, whatsapp:family"}
            spellCheck={false}
          />
          <span className="settings-suffix">comma list</span>
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="connector-target">Session target</label>
          <div className="connector-target-grid">
            <select
              id="connector-target"
              className="settings-select"
              value={form.targetMode}
              onChange={(e) => setForm((f) => ({ ...f, targetMode: e.target.value as FormState["targetMode"] }))}
            >
              <option value="activeTab">Active shellX tab</option>
              <option value="fixedTab">Fixed tab id</option>
            </select>
            {form.targetMode === "fixedTab" && (
              <div className="connector-session-picker">
                <select
                  className="settings-select"
                  value={form.fixedTabId}
                  onChange={(e) => setForm((f) => ({ ...f, fixedTabId: e.target.value }))}
                >
                  <option value="">{sessions.length ? "Choose live session" : "No live sessions connected"}</option>
                  {form.fixedTabId && !selectedSession && (
                    <option value={form.fixedTabId}>
                      Saved tab {shortTabId(form.fixedTabId)} (not live now)
                    </option>
                  )}
                  {sessions.map((session, index) => (
                    <option key={session.tabId} value={session.tabId}>
                      {formatSessionOption(session, index + 1)}
                    </option>
                  ))}
                </select>
                <span className="connector-session-id">
                  {form.fixedTabId
                    ? `tabId ${form.fixedTabId}`
                    : "Open or connect a shellX tab, then refresh."}
                </span>
              </div>
            )}
          </div>
          <span className="settings-suffix">routing</span>
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="connector-dispatch">Dispatch</label>
          <select
            id="connector-dispatch"
            className="settings-select"
            value={form.dispatchMode}
            onChange={(e) => setForm((f) => ({ ...f, dispatchMode: e.target.value as DispatchMode }))}
          >
            <option value="inbox">Inbox only</option>
            <option value="autoPrompt">Auto prompt</option>
          </select>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={form.requireApproval}
              onChange={(e) => setForm((f) => ({ ...f, requireApproval: e.target.checked }))}
            />
            Require review
          </label>
        </div>

        <p className="connector-help">{providerHelp}</p>

        <div className="connector-editor-actions">
          <button type="button" className="settings-pill" onClick={() => void handleSave()} disabled={!canSave}>
            {saving ? "Saving…" : "Save connector"}
          </button>
        </div>
      </section>

      {connectors.length === 0 ? (
        <div className="vault-empty">
          No outside connectors yet. Create a Telegram bot connector or
          a generic relay for WhatsApp/Discord bridges.
        </div>
      ) : (
        <div className="connectors-list" role="list">
          {connectors.map((connector) => (
            <ConnectorRow
              key={connector.id}
              connector={connector}
              sessions={sessions}
              testing={testingId === connector.id}
              onEdit={() => setForm(formFromConnector(connector))}
              onTest={() => void handleTest(connector)}
              onDelete={() => void handleDelete(connector)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectorRow({
  connector,
  sessions,
  testing,
  onEdit,
  onTest,
  onDelete,
}: {
  connector: OutsideConnector;
  sessions: LiveSession[];
  testing: boolean;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
}): JSX.Element {
  const provider = connector.provider.kind === "telegram" ? "Telegram" : "Relay";
  const allowed = connector.provider.kind === "telegram"
    ? connector.provider.allowedChatIds
    : connector.provider.allowedSenderIds;
  const target = formatTarget(connector.target, sessions);
  const lastTest = connector.lastTestMs ? new Date(connector.lastTestMs).toLocaleString() : "not tested";

  return (
    <div className="connector-row" role="listitem">
      <div className="connector-row-main">
        <div className="connector-row-title">
          <span className="connection-label">{connector.label}</span>
          <span className={`connector-state ${connector.enabled ? "on" : "off"}`}>
            {connector.enabled ? "enabled" : "disabled"}
          </span>
        </div>
        <span className="connection-target">
          {provider} · {connector.dispatchMode === "inbox" ? "inbox" : "auto prompt"} · {target}
        </span>
        <span className="connector-route">
          {allowed.length ? `Allowed: ${allowed.join(", ")}` : "Allowed: any sender until runtime gating is tightened"}
        </span>
        {connector.lastError && <span className="connector-error">{connector.lastError}</span>}
      </div>
      <div className="connection-row-meta">
        <span className={`connection-kind connection-kind-${connector.provider.kind}`}>
          {provider}
        </span>
        <span className="connection-last-used">test {lastTest}</span>
        <button type="button" className="settings-pill" onClick={onTest} disabled={testing}>
          {testing ? "…" : "Test"}
        </button>
        <button type="button" className="settings-pill" onClick={onEdit}>Edit</button>
        <button type="button" className="settings-pill settings-pill-danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

function VaultKeyInput({
  id,
  value,
  keys,
  onChange,
}: {
  id: string;
  value: string;
  keys: string[];
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="vault-key-combo">
      <input
        id={id}
        className="settings-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        list={`${id}-options`}
      />
      <datalist id={`${id}-options`}>
        {keys.map((key) => <option key={key} value={key} />)}
      </datalist>
    </div>
  );
}

function emptyForm(providerKind: ProviderKind): FormState {
  return {
    id: "",
    label: providerKind === "telegram" ? "Telegram" : "Local relay",
    providerKind,
    enabled: false,
    targetMode: "activeTab",
    fixedTabId: "",
    dispatchMode: "inbox",
    requireApproval: true,
    vaultKey: providerKind === "telegram" ? DEFAULT_TELEGRAM_KEY : DEFAULT_RELAY_KEY,
    secretValue: "",
    allowedIdsText: "",
    createdMs: 0,
    updatedMs: 0,
  };
}

function formFromConnector(connector: OutsideConnector): FormState {
  const providerKind = connector.provider.kind;
  const allowed = providerKind === "telegram"
    ? connector.provider.allowedChatIds
    : connector.provider.allowedSenderIds;
  const vaultKey = providerKind === "telegram"
    ? connector.provider.botTokenVaultKey
    : connector.provider.sharedSecretVaultKey;
  return {
    id: connector.id,
    label: connector.label,
    providerKind,
    enabled: connector.enabled,
    targetMode: connector.target.mode,
    fixedTabId: connector.target.mode === "fixedTab" ? connector.target.tabId : "",
    dispatchMode: connector.dispatchMode,
    requireApproval: connector.requireApproval,
    vaultKey,
    secretValue: "",
    allowedIdsText: allowed.join(", "),
    createdMs: connector.createdMs,
    updatedMs: connector.updatedMs,
  };
}

function splitIds(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeLiveSessions(
  rows: Array<Partial<LiveSession>>,
  tabOrder: Map<string, { index: number; title: string | null }>,
): LiveSession[] {
  const normalized: LiveSession[] = [];
  rows.forEach((row) => {
    const tabId = typeof row.tabId === "string" ? row.tabId.trim() : "";
    if (!tabId) return;
    const ordered = tabOrder.get(tabId);
    normalized.push({
      ...row,
      tabId,
      title: typeof row.title === "string" ? row.title : ordered?.title ?? null,
    });
  });
  return normalized.sort((a, b) => {
    const aOrder = tabOrder.get(a.tabId)?.index ?? Number.MAX_SAFE_INTEGER;
    const bOrder = tabOrder.get(b.tabId)?.index ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    const aLive = a.hasActiveChild ? 0 : 1;
    const bLive = b.hasActiveChild ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;
    return sessionSortLabel(a).localeCompare(sessionSortLabel(b));
  });
}

function formatTarget(target: ConnectorTarget, sessions: LiveSession[]): string {
  if (target.mode === "activeTab") return "active tab";
  const idx = sessions.findIndex((row) => row.tabId === target.tabId);
  const session = idx >= 0 ? sessions[idx] : null;
  if (!session) return `fixed ${shortTabId(target.tabId)}`;
  return `fixed ${idx + 1} (${session.title?.trim() || pathTail(session.cwd)})`;
}

function formatSessionOption(session: LiveSession, index: number): string {
  const status = session.hasActiveChild ? "running" : "idle";
  const title = session.title?.trim() || pathTail(session.cwd);
  return `${index} · ${title} · ${transportLabel(session)} · ${status} · ${shortTabId(session.tabId)}`;
}

function sessionSortLabel(session: LiveSession): string {
  return `${session.title ?? ""} ${transportLabel(session)} ${pathTail(session.cwd)} ${session.tabId}`;
}

function transportLabel(session: LiveSession): string {
  if (session.isSsh) return session.sshHost ? `ssh ${session.sshHost}` : "ssh";
  if (session.isWsl) return session.wslDistro ? `wsl ${session.wslDistro}` : "wsl";
  return "local";
}

function pathTail(path: string | null | undefined): string {
  const trimmed = path?.trim();
  if (!trimmed) return "no cwd";
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

function shortTabId(tabId: string): string {
  return tabId.length > 12 ? tabId.slice(0, 12) : tabId;
}

function readStoredTabOrder(): Map<string, { index: number; title: string | null }> {
  const out = new Map<string, { index: number; title: string | null }>();
  try {
    const raw = window.localStorage.getItem("grok-shell.session-tabs.v2");
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return out;
    parsed.forEach((row: Partial<StoredTabRef>, index) => {
      if (typeof row?.tabId !== "string" || !row.tabId.trim()) return;
      out.set(row.tabId, {
        index,
        title: typeof row.title === "string" && row.title.trim() ? row.title : null,
      });
    });
  } catch {
    return out;
  }
  return out;
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
