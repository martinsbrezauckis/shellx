/**
 * Settings -> Connectors.
 *
 * Outside connectors are user-facing channels such as Telegram bots
 * and Discord bots. Config, tests, and simulated
 * inbound events share the same backend contract so channel behavior is
 * auditable before it reaches the connector inbox.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { apiGet } from "../../lib/debug-api";
import { connectorLabelForSave } from "../../lib/outside-connectors";
import { inTauri } from "../../lib/tauri-bridge";

type ProviderKind = "telegram" | "discord";
type DispatchMode = "inbox" | "autoPrompt";

interface TelegramProvider {
  kind: "telegram";
  botTokenVaultKey: string;
  allowedChatIds: string[];
}

interface DiscordProvider {
  kind: "discord";
  botTokenVaultKey: string;
  allowedTargetIds: string[];
}

type ConnectorProvider = TelegramProvider | DiscordProvider;

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

type ConnectorEventStatus = "inbox" | "autoPrompt" | "rejected" | "error";

interface OutsideConnectorEvent {
  id: string;
  connectorId: string;
  connectorLabel: string;
  provider: ProviderKind;
  direction: "inbound" | "outbound" | "system";
  status: ConnectorEventStatus;
  senderId: string;
  conversationId?: string | null;
  guildId?: string | null;
  target: string;
  dispatchMode: DispatchMode;
  requireApproval: boolean;
  textPreview: string;
  externalPreview: string;
  reason?: string | null;
  createdMs: number;
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

interface SimFormState {
  connectorId: string;
  senderId: string;
  conversationId: string;
  guildId: string;
  text: string;
}

const DEFAULT_TELEGRAM_KEY = "telegram/bot-token";
const DEFAULT_DISCORD_KEY = "discord/bot-token";
const PROVIDER_TABS: ProviderKind[] = ["telegram", "discord"];

export function ConnectorsTab(): JSX.Element {
  const [connectors, setConnectors] = useState<OutsideConnector[]>([]);
  const [vaultKeys, setVaultKeys] = useState<string[]>([]);
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [form, setForm] = useState<FormState>(() => emptyForm("telegram"));
  const [simForm, setSimForm] = useState<SimFormState>({
    connectorId: "",
    senderId: "",
    conversationId: "",
    guildId: "",
    text: "",
  });
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);
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
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (simForm.connectorId || connectors.length === 0) return;
    setSimForm((f) => ({ ...f, connectorId: connectors[0]?.id ?? "" }));
  }, [connectors, simForm.connectorId]);

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
  const selectedSimConnector = useMemo(
    () => connectors.find((connector) => connector.id === simForm.connectorId) ?? null,
    [connectors, simForm.connectorId],
  );
  const canSave = form.vaultKey.trim().length > 0
    && (form.targetMode !== "fixedTab" || form.fixedTabId.trim().length > 0)
    && !saving;
  const canSimulate = Boolean(selectedSimConnector)
    && simForm.senderId.trim().length > 0
    && simForm.text.trim().length > 0
    && !simulating;
  const providerHelp = useMemo(() => {
    switch (form.providerKind) {
      case "telegram":
        return "Telegram uses a BotFather token plus explicit allowed chat IDs. Inbox records messages; Session chat sends allowlisted messages to the selected shellX tab and returns Grok's text reply.";
      case "discord":
        return "Discord uses a bot token plus explicit allowed user IDs. Discord intake is DM-only in this release.";
    }
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
        label: connectorLabelForSave(form.providerKind, form.label),
        enabled: form.enabled,
        provider: buildProvider(form.providerKind, vaultKey, splitIds(form.allowedIdsText)),
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

  async function handleSimulate(): Promise<void> {
    if (!canSimulate || !selectedSimConnector) return;
    setSimulating(true);
    try {
      const event = await invoke<OutsideConnectorEvent>("outside_connectors_simulate", {
        id: selectedSimConnector.id,
        input: {
          senderId: simForm.senderId.trim(),
          conversationId: optionalText(simForm.conversationId),
          guildId: optionalText(simForm.guildId),
          text: simForm.text.trim(),
        },
      });
      setToast({
        kind: event.status === "rejected" || event.status === "error" ? "err" : "ok",
        text: `${selectedSimConnector.label}: ${statusLabel(event.status)}`,
      });
      setSimForm((f) => ({ ...f, text: "" }));
      await refresh();
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    } finally {
      setSimulating(false);
    }
  }

  function handleProviderChange(providerKind: ProviderKind): void {
    setForm((f) => ({
      ...f,
      providerKind,
      label: defaultLabel(providerKind),
      vaultKey: defaultVaultKey(providerKind),
      allowedIdsText: "",
      secretValue: "",
      dispatchMode: "inbox",
      requireApproval: true,
    }));
  }

  return (
    <div className="settings-tab-body connectors-tab">
      <div className="connectors-header">
        <p className="settings-tab-hint">
          Outside channels connect people to shellX. Keep new
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
          <label className="settings-label" id="connector-provider-label">Provider</label>
          <div className="connector-provider-tabs" role="tablist" aria-labelledby="connector-provider-label">
            {PROVIDER_TABS.map((providerKind) => (
              <button
                key={providerKind}
                type="button"
                role="tab"
                aria-selected={form.providerKind === providerKind}
                className={`connector-provider-tab ${form.providerKind === providerKind ? "active" : ""}`}
                onClick={() => handleProviderChange(providerKind)}
              >
                <span>{providerLabel(providerKind)}</span>
                <span className="connector-provider-mode">{providerModeLabel(providerKind)}</span>
              </button>
            ))}
          </div>
          <span className="settings-suffix">{providerModeLabel(form.providerKind)}</span>
        </div>

        <div className="settings-row">
          <span className="settings-label">Receiver</span>
          <div className="connector-provider-tabs connector-state-tabs" role="group" aria-label="Connector receiver state">
            <button
              type="button"
              className={`connector-provider-tab ${!form.enabled ? "active" : ""}`}
              onClick={() => setForm((f) => ({ ...f, enabled: false }))}
            >
              Paused
            </button>
            <button
              type="button"
              className={`connector-provider-tab ${form.enabled ? "active" : ""}`}
              onClick={() => setForm((f) => ({ ...f, enabled: true }))}
            >
              Live
            </button>
          </div>
          <span className="settings-suffix">message intake</span>
        </div>

        <div className="settings-row">
          <span className="settings-label">Delivery</span>
          <div className="connector-provider-tabs connector-state-tabs" role="group" aria-label="Connector delivery mode">
            <button
              type="button"
              className={`connector-provider-tab ${form.dispatchMode === "inbox" ? "active" : ""}`}
              onClick={() => setForm((f) => ({ ...f, dispatchMode: "inbox", requireApproval: true }))}
            >
              Inbox
            </button>
            <button
              type="button"
              className={`connector-provider-tab ${form.dispatchMode === "autoPrompt" ? "active" : ""}`}
              onClick={() => setForm((f) => ({ ...f, dispatchMode: "autoPrompt", requireApproval: false }))}
              disabled={form.providerKind !== "telegram"}
              title={form.providerKind === "telegram" ? "Send allowlisted Telegram messages to Grok" : "Session chat is wired for Telegram first"}
            >
              Session chat
            </button>
          </div>
          <span className="settings-suffix">{form.dispatchMode === "autoPrompt" ? "send to Grok" : "review first"}</span>
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="connector-vault-key">Bot token key</label>
          <VaultKeyInput
            id="connector-vault-key"
            value={form.vaultKey}
            keys={vaultKeys}
            onChange={(vaultKey) => setForm((f) => ({ ...f, vaultKey }))}
          />
          <span className="settings-suffix">Vault</span>
        </div>

        <div className="settings-row">
          <label className="settings-label" htmlFor="connector-secret">Bot token</label>
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
            {allowedLabel(form.providerKind)}
          </label>
          <input
            id="connector-allowed"
            className="settings-input"
            value={form.allowedIdsText}
            onChange={(e) => setForm((f) => ({ ...f, allowedIdsText: e.target.value }))}
            placeholder={allowedPlaceholder(form.providerKind)}
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

        <p className="connector-help">{providerHelp}</p>

        <div className="connector-editor-actions">
          <button type="button" className="settings-pill" onClick={() => void handleSave()} disabled={!canSave}>
            {saving ? "Saving…" : "Save connector"}
          </button>
        </div>
      </section>

      {connectors.length === 0 ? (
        <div className="vault-empty">
          No outside connectors yet. Create a Telegram or Discord bot connector.
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

      <section className="connector-editor connector-test-panel" aria-label="Connector test inbound">
        <div className="connector-editor-head">
          <h3>Test inbound</h3>
        </div>

        <div className="connector-sim-grid">
          <label className="settings-label" htmlFor="connector-sim-connector">Connector</label>
          <select
            id="connector-sim-connector"
            className="settings-select"
            value={simForm.connectorId}
            onChange={(e) => setSimForm((f) => ({ ...f, connectorId: e.target.value }))}
          >
            <option value="">{connectors.length ? "Choose connector" : "No connectors"}</option>
            {connectors.map((connector) => (
              <option key={connector.id} value={connector.id}>
                {connector.label} · {providerLabel(connector.provider.kind)}
              </option>
            ))}
          </select>

          <label className="settings-label" htmlFor="connector-sim-sender">
            {selectedSimConnector?.provider.kind === "discord" ? "User" : "Sender"}
          </label>
          <input
            id="connector-sim-sender"
            className="settings-input"
            value={simForm.senderId}
            onChange={(e) => setSimForm((f) => ({ ...f, senderId: e.target.value }))}
            placeholder={selectedSimConnector?.provider.kind === "discord" ? "123456789 or user:123456789" : "123456789"}
            spellCheck={false}
          />

          <label className="settings-label" htmlFor="connector-sim-conversation">
            {selectedSimConnector?.provider.kind === "discord" ? "DM channel" : "Chat"}
          </label>
          <input
            id="connector-sim-conversation"
            className="settings-input"
            value={simForm.conversationId}
            onChange={(e) => setSimForm((f) => ({ ...f, conversationId: e.target.value }))}
            placeholder={selectedSimConnector?.provider.kind === "discord" ? "optional DM channel id" : "same as sender if DM"}
            spellCheck={false}
          />

          <label className="settings-label" htmlFor="connector-sim-text">Message</label>
          <input
            id="connector-sim-text"
            className="settings-input connector-sim-message"
            value={simForm.text}
            onChange={(e) => setSimForm((f) => ({ ...f, text: e.target.value }))}
            placeholder="Message as the outside user would send it"
          />

          <div className="connector-sim-actions">
            <button type="button" className="settings-pill" onClick={() => void handleSimulate()} disabled={!canSimulate}>
              {simulating ? "…" : "Simulate inbound"}
            </button>
          </div>
        </div>
      </section>
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
  const provider = providerLabel(connector.provider.kind);
  const allowed = allowedIds(connector);
  const target = formatTarget(connector.target, sessions);
  const lastTest = connector.lastTestMs ? new Date(connector.lastTestMs).toLocaleString() : "not tested";
  const stateKind = connector.enabled ? (connector.lastError ? "failing" : "on") : "off";
  const stateLabel = connector.enabled ? (connector.lastError ? "failing" : "enabled") : "disabled";

  return (
    <div className="connector-row" role="listitem">
      <div className="connector-row-main">
        <div className="connector-row-title">
          <span className="connection-label">{connector.label}</span>
          <span className={`connector-state ${stateKind}`}>
            {stateLabel}
          </span>
        </div>
        <span className="connection-target">
          {provider} · {connector.dispatchMode === "autoPrompt" ? "session chat" : "inbox"} · {target}
        </span>
        <span className="connector-route">
          {allowed.length ? `Allowed: ${allowed.join(", ")}` : "Allowed: none configured"}
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
    label: defaultLabel(providerKind),
    providerKind,
    enabled: false,
    targetMode: "activeTab",
    fixedTabId: "",
    dispatchMode: "inbox",
    requireApproval: true,
    vaultKey: defaultVaultKey(providerKind),
    secretValue: "",
    allowedIdsText: "",
    createdMs: 0,
    updatedMs: 0,
  };
}

function formFromConnector(connector: OutsideConnector): FormState {
  const providerKind = connector.provider.kind;
  const allowed = allowedIds(connector);
  const vaultKey = connector.provider.botTokenVaultKey;
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

function buildProvider(providerKind: ProviderKind, vaultKey: string, allowed: string[]): ConnectorProvider {
  switch (providerKind) {
    case "telegram":
      return {
        kind: "telegram",
        botTokenVaultKey: vaultKey,
        allowedChatIds: allowed,
      };
    case "discord":
      return {
        kind: "discord",
        botTokenVaultKey: vaultKey,
        allowedTargetIds: allowed,
      };
  }
}

function allowedIds(connector: OutsideConnector): string[] {
  switch (connector.provider.kind) {
    case "telegram":
      return connector.provider.allowedChatIds;
    case "discord":
      return connector.provider.allowedTargetIds;
  }
}

function defaultLabel(providerKind: ProviderKind): string {
  switch (providerKind) {
    case "telegram": return "Telegram";
    case "discord": return "Discord";
  }
}

function defaultVaultKey(providerKind: ProviderKind): string {
  switch (providerKind) {
    case "telegram": return DEFAULT_TELEGRAM_KEY;
    case "discord": return DEFAULT_DISCORD_KEY;
  }
}

function providerLabel(providerKind: ProviderKind): string {
  switch (providerKind) {
    case "telegram": return "Telegram";
    case "discord": return "Discord";
  }
}

function providerModeLabel(providerKind: ProviderKind): string {
  switch (providerKind) {
    case "telegram": return "native";
    case "discord": return "native";
  }
}

function allowedLabel(providerKind: ProviderKind): string {
  switch (providerKind) {
    case "telegram": return "Allowed chats";
    case "discord": return "Allowed users";
  }
}

function allowedPlaceholder(providerKind: ProviderKind): string {
  switch (providerKind) {
    case "telegram": return "123456789, -1001234567890";
    case "discord": return "111222333444555666, user:123456789012345678";
  }
}

function statusLabel(status: ConnectorEventStatus): string {
  switch (status) {
    case "inbox": return "inbox";
    case "autoPrompt": return "inbox";
    case "rejected": return "rejected";
    case "error": return "error";
  }
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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
