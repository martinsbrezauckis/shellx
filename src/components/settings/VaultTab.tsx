/**
 * src/components/settings/VaultTab.tsx — Settings → Vault editor.
 *
 * Flat inline editor for ShellX Vault compatibility keys (xAI API key,
 * future connectors). MicButton's no-key banner links straight here.
 *
 * Backend Tauri commands (src-tauri/src/lib.rs):
 * invoke("vault_list_keys", { prefix: null }) → string[]
 * invoke("vault_set", { key, value }) →  * invoke("vault_delete", { key }) →  * invoke("vault_status") → VaultStatus
 * invoke("vault_get", { key }) → string | null (explicit user copy/reveal only)
 *
 * Security boundary (see src-tauri/src/shellx_vault):
 * - Values are hidden by default. The user can copy without display or
 * explicitly reveal one row after unlocking Vault.
 * - Add/replace inputs remain type="password" so editing does not
 * shoulder-surf by default.
 * - Agent and browser paths use ShellX Vault grant receipts or
 * mediated fills; raw reveal remains a user-facing, explicit path.
 * - Delete uses an inline two-click confirmation (no modal); the
 * row's Delete button flips to "Confirm" for ~5s before reverting.
 *
 * UX shape * ┌─ keyring badge ────────────────────────────────────┐
 * │ keyring: ok / fallback-keyfile / unavailable │
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
import { useCallback, useEffect, useMemo, useState, type JSX, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ShellIcon } from "../icons";
import { VaultPasswordGenerator } from "../VaultPasswordGenerator";
import { VaultGrantsPanel, type GrantOperation, type GrantSummary } from "./VaultGrantsPanel";
import { VaultSetupPanel } from "./VaultSetupPanel";
import { isTrustedShellxUserEvent, type ShellxUserEventLike } from "../../lib/trusted-user-event";
import { generateVaultPassword } from "../../lib/vault-password-generator";
import type { VaultPanelIntent } from "../../lib/vault-ui";

/** Mirrors shellx_vault::ShellxVaultStatus on the Rust side. camelCase wire. */
interface VaultStatus {
  mode?: "unconfigured" | "legacyLimited" | "local" | "external";
  unlocked?: boolean;
  recoveryConfirmed?: boolean;
  rememberedDeviceEnabled?: boolean;
  legacyVaultDetected?: boolean;
  activeGrants?: number;
  pendingDeposits?: number;
  syncPending?: boolean;
  lastError?: string | null;
  initialized?: boolean;
  keyringAvailable?: boolean;
  usingFallbackKeyfile?: boolean;
  keyCount?: number;
}

interface VaultKeyMeta {
  key: string;
  description?: string | null;
  userOnly?: boolean;
  resourceKind?: VaultResourceKind;
  resourceSummary?: string | null;
  resourceProvider?: string | null;
  resourceFields?: string[];
  lastModifiedMs?: number;
}

/** Toast surface — single line, auto-dismissed, success or error. */
type Toast = { kind: "ok" | "err"; text: string } | null;

type PermissionLevel = "userOnly" | "visible" | "browserFillAlways" | "toolUseAlways";
type VaultResourceKind = "secret" | "profileCard" | "emailInbox" | "stripeAgentWallet";
type VaultResourceFormTab = "secret" | "profileCard" | "stripeAgentWallet";
type VaultWorkspaceTab = "secrets" | "grants" | "setup";

const VAULT_RESOURCE_FORM_TABS: Array<{
  id: VaultResourceFormTab;
  label: string;
  countKind: VaultResourceKind;
}> = [
  { id: "secret", label: "Secrets", countKind: "secret" },
  { id: "profileCard", label: "Profile cards", countKind: "profileCard" },
  { id: "stripeAgentWallet", label: "Agent wallets", countKind: "stripeAgentWallet" },
];

/** Per-row local state for the inline "Replace value" + "Delete?" flows. */
type RowState = {
  replacing: boolean;
  replaceValue: string;
  editingMetadata: boolean;
  descriptionValue: string;
  userOnlyValue: boolean;
  confirmingDelete: boolean;
  revealValue: string | null;
};

function defaultRowState(): RowState {
  return {
    replacing: false,
    replaceValue: "",
    editingMetadata: false,
    descriptionValue: "",
    userOnlyValue: false,
    confirmingDelete: false,
    revealValue: null,
  };
}

export function VaultTab({
  intent = "overview",
  intentSeq = 0,
  externalStatus,
  statusRefreshSeq = 0,
  onStatusChange,
}: {
  intent?: VaultPanelIntent;
  intentSeq?: number;
  externalStatus?: VaultStatus | null;
  statusRefreshSeq?: number;
  onStatusChange?: (status: VaultStatus) => void;
} = {}): JSX.Element {
  const [entries, setEntries] = useState<VaultKeyMeta[]>([]);
  const [grants, setGrants] = useState<GrantSummary[]>([]);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
 // Add-secret form state (top of tab).
  const [addKey, setAddKey] = useState("");
  const [addValue, setAddValue] = useState("");
  const [addDescription, setAddDescription] = useState("");
  const [addUserOnly, setAddUserOnly] = useState(false);
  const [addValueVisible, setAddValueVisible] = useState(false);
  const [adding, setAdding] = useState(false);
  const [profileForm, setProfileForm] = useState({
    label: "",
    fullName: "",
    email: "",
    username: "",
    company: "",
    role: "",
    phone: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    region: "",
    postalCode: "",
    country: "",
    description: "",
    userOnly: false,
  });
  const [agentWalletForm, setAgentWalletForm] = useState({
    label: "",
    stripeMode: "test",
    stripeApiKeyRef: "",
    webhookSecretRef: "",
    accountRef: "",
    cardholderRef: "",
    cardRef: "",
    budgetSummary: "",
    allowedOrigins: "",
    allowedCategories: "",
    status: "dryRun",
    description: "",
    userOnly: false,
  });
  const [resourceFormTab, setResourceFormTab] = useState<VaultResourceFormTab>("secret");
  const [workspaceTab, setWorkspaceTab] = useState<VaultWorkspaceTab>("secrets");
  const [secretGeneratorOpen, setSecretGeneratorOpen] = useState(false);
 // Per-row inline UI state, keyed by secret name.
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

 /** Load both the key list and the status badge in parallel. */
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const [k, s, g] = await Promise.all([
        invoke<VaultKeyMeta[]>("vault_list_keys_with_meta"),
        invoke<VaultStatus>("vault_status"),
        invoke<GrantSummary[]>("shellx_vault_list_grants"),
      ]);
 // Sort alphabetically — same shape the user expects from `pass(1)`.
      setEntries([...k].sort((a, b) => a.key.localeCompare(b.key)));
      setStatus(s);
      onStatusChange?.(s);
      setGrants(g);
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    } finally {
      setBusy(false);
    }
  }, [onStatusChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (externalStatus) setStatus(externalStatus);
  }, [externalStatus]);

  useEffect(() => {
    if (statusRefreshSeq > 0) void refresh();
  }, [refresh, statusRefreshSeq]);

  useEffect(() => {
    if (intent === "newSecret" || intent === "generatePassword") {
      setWorkspaceTab("secrets");
      setResourceFormTab("secret");
      window.setTimeout(() => {
        document.querySelector<HTMLInputElement>("[data-debug-id='vault-secret-key-input']")?.focus();
      }, 50);
    }
    if (intent === "generatePassword") {
      setSecretGeneratorOpen(true);
    }
  }, [intent, intentSeq]);

 // Auto-dismiss toast after 3s. Errors hang around the same time —
 // user can re-trigger the action to see it again.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const keys = useMemo(() => entries.map((entry) => entry.key), [entries]);

  const activeGrantsBySecretRef = useMemo(() => {
    const now = Date.now();
    const grouped = new Map<string, GrantSummary[]>();
    for (const grant of grants) {
      if (!grant.approved) continue;
      if (grant.revoked) continue;
      if (grant.expiresAtMs && grant.expiresAtMs <= now) continue;
      const existing = grouped.get(grant.secretRef) ?? [];
      existing.push(grant);
      grouped.set(grant.secretRef, existing);
    }
    return grouped;
  }, [grants]);

  const filtered = useMemo(
    () => {
      const needle = filter.trim().toLowerCase();
      if (!needle) return entries;
      return entries.filter((entry) => {
        const description = entry.description ?? "";
        return (
          entry.key.toLowerCase().includes(needle) ||
          description.toLowerCase().includes(needle)
        );
      });
    },
    [entries, filter],
  );

  const groupedEntries = useMemo(() => {
    const groups: Record<VaultResourceKind, VaultKeyMeta[]> = {
      secret: [],
      profileCard: [],
      emailInbox: [],
      stripeAgentWallet: [],
    };
    for (const entry of filtered) {
      groups[resourceKindOf(entry)].push(entry);
    }
    return groups;
  }, [filtered]);

 /** Update one row's inline state without disturbing the others. */
  const patchRow = useCallback((key: string, patch: Partial<RowState>) => {
    setRowState((prev) => {
      const cur: RowState = prev[key] ?? {
        ...defaultRowState(),
      };
      return { ...prev, [key]: { ...cur, ...patch } };
    });
  }, []);

 /** Save flow for the top "Add a secret" row. */
  async function handleAdd(): Promise<void> {
    await handleAddWithValue(addValue);
  }

  async function handleAddWithValue(value: string): Promise<void> {
    const key = addKey.trim();
    if (!key) {
      setToast({ kind: "err", text: "Add a secret name before saving." });
      return;
    }
    if (!value) return;
    setAdding(true);
    try {
      await invoke("vault_set", {
        key,
        value,
        description: descriptionOrNull(addDescription),
        userOnly: addUserOnly,
      });
      setAddKey("");
      setAddValue("");
      setAddDescription("");
      setAddUserOnly(false);
      setToast({ kind: "ok", text: `Saved ${key}` });
      await refresh();
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    } finally {
      setAdding(false);
    }
  }

  async function handleAddProfileCard(): Promise<void> {
    const label = profileForm.label.trim();
    if (!label) return;
    const value = JSON.stringify({
      kind: "profileCard",
      fullName: profileForm.fullName.trim(),
      email: profileForm.email.trim(),
      username: profileForm.username.trim(),
      company: profileForm.company.trim(),
      role: profileForm.role.trim(),
      phone: profileForm.phone.trim(),
      address: {
        line1: profileForm.addressLine1.trim(),
        line2: profileForm.addressLine2.trim(),
        city: profileForm.city.trim(),
        region: profileForm.region.trim(),
        postalCode: profileForm.postalCode.trim(),
        country: profileForm.country.trim(),
      },
    });
    const key = `profile-cards/${slug(label)}`;
    setAdding(true);
    try {
      await invoke("vault_set_resource", {
        key,
        value,
        description: descriptionOrNull(profileForm.description),
        userOnly: profileForm.userOnly,
        resourceKind: "profileCard",
        resourceSummary: profileResourceSummary(profileForm),
        resourceProvider: null,
        resourceFields: resourceFieldsFromObject({
          fullName: profileForm.fullName,
          email: profileForm.email,
          username: profileForm.username,
          company: profileForm.company,
          role: profileForm.role,
          phone: profileForm.phone,
          address: [
            profileForm.addressLine1,
            profileForm.addressLine2,
            profileForm.city,
            profileForm.region,
            profileForm.postalCode,
            profileForm.country,
          ].join(" "),
        }),
      });
      setProfileForm({
        label: "",
        fullName: "",
        email: "",
        username: "",
        company: "",
        role: "",
        phone: "",
        addressLine1: "",
        addressLine2: "",
        city: "",
        region: "",
        postalCode: "",
        country: "",
        description: "",
        userOnly: false,
      });
      setToast({ kind: "ok", text: `Saved ${key}` });
      await refresh();
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    } finally {
      setAdding(false);
    }
  }

  async function handleAddAgentWallet(): Promise<void> {
    const label = agentWalletForm.label.trim();
    if (!label) return;
    const key = `agent-wallets/${slug(label)}`;
    setAdding(true);
    try {
      await invoke("vault_set_resource", {
        key,
        value: JSON.stringify({
          kind: "stripeAgentWallet",
          provider: "stripe",
          stripeMode: agentWalletForm.stripeMode,
          stripeApiKeyRef: agentWalletForm.stripeApiKeyRef.trim(),
          webhookSecretRef: agentWalletForm.webhookSecretRef.trim(),
          accountRef: agentWalletForm.accountRef.trim(),
          cardholderRef: agentWalletForm.cardholderRef.trim(),
          cardRef: agentWalletForm.cardRef.trim(),
          budgetSummary: agentWalletForm.budgetSummary.trim(),
          allowedOrigins: splitCsv(agentWalletForm.allowedOrigins),
          allowedCategories: splitCsv(agentWalletForm.allowedCategories),
          status: agentWalletForm.status,
        }),
        description: descriptionOrNull(agentWalletForm.description),
        userOnly: agentWalletForm.userOnly,
        resourceKind: "stripeAgentWallet",
        resourceSummary: [agentWalletForm.stripeMode, agentWalletForm.budgetSummary, agentWalletForm.status]
          .map((value) => value.trim())
          .filter(Boolean)
          .join(" · "),
        resourceProvider: "stripe",
        resourceFields: [
          "allowedCategories",
          "allowedOrigins",
          "budgetSummary",
          "status",
          "stripeApiKeyRef",
          "stripeRefs",
          "webhookSecretRef",
        ],
      });
      setAgentWalletForm({
        label: "",
        stripeMode: "test",
        stripeApiKeyRef: "",
        webhookSecretRef: "",
        accountRef: "",
        cardholderRef: "",
        cardRef: "",
        budgetSummary: "",
        allowedOrigins: "",
        allowedCategories: "",
        status: "dryRun",
        description: "",
        userOnly: false,
      });
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

 /** User-only copy/reveal path. Agents and Debug API raw reveal remain denied. */
  async function loadSecretForUser(key: string, event?: ShellxUserEventLike): Promise<string | null> {
    if (!isTrustedShellxUserEvent(event)) {
      setToast({ kind: "err", text: "Secret reveal requires a direct user click." });
      return null;
    }
    try {
      const value = await invoke<string | null>("vault_get", { key });
      if (value === null || value === undefined) {
        setToast({ kind: "err", text: `No value found for ${key}` });
        return null;
      }
      return value;
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
      return null;
    }
  }

  async function handleCopyValue(key: string, event?: ShellxUserEventLike): Promise<void> {
    const value = await loadSecretForUser(key, event);
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      setToast({ kind: "ok", text: `Copied ${key}` });
    } catch {
      setToast({ kind: "err", text: "Clipboard blocked. Use Reveal and copy manually." });
    }
  }

  async function handleRevealValue(key: string, event?: ShellxUserEventLike): Promise<void> {
    const current = rowState[key];
    if (current?.revealValue !== null && current?.revealValue !== undefined) {
      patchRow(key, { revealValue: null });
      return;
    }
    const value = await loadSecretForUser(key, event);
    if (value === null) return;
    patchRow(key, { revealValue: value });
    setToast({ kind: "ok", text: `Revealed ${key}` });
  }

 /** Update non-secret row metadata without touching the encrypted value. */
  async function handleUpdateMetadata(key: string): Promise<void> {
    const cur = rowState[key];
    if (!cur) return;
    try {
      await invoke("vault_update_metadata", {
        key,
        description: descriptionOrNull(cur.descriptionValue),
        userOnly: cur.userOnlyValue,
      });
      patchRow(key, { editingMetadata: false });
      setToast({ kind: "ok", text: `Updated ${key} metadata` });
      await refresh();
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    }
  }

 /** Set the row-level visibility and optional persistent use grants. */
  async function handleSetPermission(
    entry: VaultKeyMeta,
    level: PermissionLevel,
    event?: ShellxUserEventLike,
  ): Promise<void> {
    if (!isTrustedShellxUserEvent(event)) {
      setToast({ kind: "err", text: "Permission changes require a direct user click." });
      return;
    }
    const key = entry.key;
    const desiredOps = desiredGrantOperationsForLevel(level, resourceKindOf(entry));
    const activeGrants = activeGrantsBySecretRef.get(key) ?? [];
    const persistentOps = new Set(
      activeGrants
        .filter((grant) => !grant.expiresAtMs)
        .map((grant) => normalizeGrantOperation(grant.operation))
        .filter((operation): operation is GrantOperation => Boolean(operation)),
    );
    setBusy(true);
    try {
      await invoke("vault_update_metadata", {
        key,
        description: descriptionOrNull(entry.description ?? ""),
        userOnly: level === "userOnly",
      });
      for (const grant of activeGrants) {
        const operation = normalizeGrantOperation(grant.operation);
        if (!operation || !desiredOps.includes(operation)) {
          await invoke("shellx_vault_revoke_grant", { grantId: grant.grantId });
        }
      }
      for (const operation of desiredOps) {
        if (persistentOps.has(operation)) continue;
        await invoke("shellx_vault_create_grant", {
          request: {
            secretRef: key,
            actorScope: { kind: "allShellxAgents" },
            operation,
            expiresAtMs: null,
          },
        });
      }
      patchRow(key, { editingMetadata: false });
      setToast({ kind: "ok", text: `${key}: ${permissionLevelLabel(level)}` });
      await refresh();
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    } finally {
      setBusy(false);
    }
  }

 /** Revoke flow from the active-grants ledger. */
  async function handleRevokeGrant(grantId: string): Promise<void> {
    setBusy(true);
    try {
      await invoke("shellx_vault_revoke_grant", { grantId });
      setToast({ kind: "ok", text: "Grant revoked" });
      await refresh();
    } catch (e) {
      setToast({ kind: "err", text: formatErr(e) });
    } finally {
      setBusy(false);
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
  const activeGrantCount = countActiveGrants(grants);

  return (
    <div className="settings-tab-body vault-tab">
      <div className="vault-workspace-tabs" role="tablist" aria-label="Vault workspace">
        <button
          type="button"
          className={`vault-workspace-tab ${workspaceTab === "secrets" ? "active" : ""}`}
          role="tab"
          aria-selected={workspaceTab === "secrets"}
          onClick={() => setWorkspaceTab("secrets")}
          data-debug-id="vault-tab-secrets"
        >
          Secrets
        </button>
        <button
          type="button"
          className={`vault-workspace-tab ${workspaceTab === "grants" ? "active" : ""}`}
          role="tab"
          aria-selected={workspaceTab === "grants"}
          onClick={() => setWorkspaceTab("grants")}
          data-debug-id="vault-tab-grants"
        >
          Active grants <span>{activeGrantCount} active</span>
        </button>
        <button
          type="button"
          className={`vault-workspace-tab ${workspaceTab === "setup" ? "active" : ""}`}
          role="tab"
          aria-selected={workspaceTab === "setup"}
          onClick={() => setWorkspaceTab("setup")}
          data-debug-id="vault-tab-setup"
        >
          Setup
        </button>
        <div className="vault-workspace-tab-spacer" />
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
            <ShellIcon name="close" size={13} />
          </button>
        </div>
      )}

      {workspaceTab === "secrets" && (
        <>
          <div className="vault-filter-row">
            <input
              type="text"
              className="settings-input"
              data-debug-id="vault-filter-input"
              placeholder={`Filter ${keys.length} key${keys.length === 1 ? "" : "s"}…`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter vault keys"
            />
          </div>

          <div className="vault-resource-forms" data-debug-id="vault-resource-form-tabs">
            <div className="vault-resource-form-tabs" role="tablist" aria-label="Vault resource editor">
              {VAULT_RESOURCE_FORM_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`vault-resource-form-tab ${resourceFormTab === tab.id ? "active" : ""}`}
                  role="tab"
                  aria-selected={resourceFormTab === tab.id}
                  data-debug-id={`vault-resource-form-tab-${tab.id}`}
                  onClick={() => setResourceFormTab(tab.id)}
                >
                  <span>{tab.label}</span>
                  <span className="vault-resource-form-tab-count">
                    {groupedEntries[tab.countKind].length}
                  </span>
                </button>
              ))}
            </div>
            <div className="vault-resource-form-panel" role="tabpanel">
              {resourceFormTab === "secret" && (
                <SecretForm
                  keyName={addKey}
                  value={addValue}
                  valueVisible={addValueVisible}
                  description={addDescription}
                  userOnly={addUserOnly}
                  busy={adding}
                  canSubmit={canAdd}
                  generatorOpen={secretGeneratorOpen}
                  onChange={(patch) => {
                    if (patch.keyName !== undefined) setAddKey(patch.keyName);
                    if (patch.value !== undefined) setAddValue(patch.value);
                    if (patch.valueVisible !== undefined) setAddValueVisible(patch.valueVisible);
                    if (patch.description !== undefined) setAddDescription(patch.description);
                    if (patch.userOnly !== undefined) setAddUserOnly(patch.userOnly);
                  }}
                  onOpenGenerator={() => setSecretGeneratorOpen(true)}
                  onCloseGenerator={() => setSecretGeneratorOpen(false)}
                  onUseGenerated={(password) => {
                    setAddValue(password);
                    setAddValueVisible(false);
                    setToast({ kind: "ok", text: "Generated password added to secret value." });
                  }}
                  onSaveGenerated={(password) => void handleAddWithValue(password)}
                  onCopyGenerated={(event) => void handleCopyGeneratedSecret(event)}
                  onSubmit={() => void handleAdd()}
                />
              )}
              {resourceFormTab === "profileCard" && (
                <ProfileCardForm
                  form={profileForm}
                  busy={adding}
                  onChange={(patch) => setProfileForm((prev) => ({ ...prev, ...patch }))}
                  onSubmit={() => void handleAddProfileCard()}
                />
              )}
              {resourceFormTab === "stripeAgentWallet" && (
                <AgentWalletForm
                  form={agentWalletForm}
                  busy={adding}
                  onChange={(patch) => setAgentWalletForm((prev) => ({ ...prev, ...patch }))}
                  onSubmit={() => void handleAddAgentWallet()}
                />
              )}
            </div>
          </div>

          <div className="vault-list" role="list">
            {filtered.length === 0 ? (
              <div className="vault-empty">
                {keys.length === 0
                  ? "Vault is empty. Add your first secret above."
                  : "No matches."}
              </div>
            ) : (
              <>
                <VaultResourceSection
                  debugId="vault-resource-section-secrets"
                  title="Secrets"
                  entries={groupedEntries.secret}
                  emptyText="No plain secrets match this filter."
                  renderEntry={renderVaultEntry}
                />
                <VaultResourceSection
                  debugId="vault-resource-section-profile-cards"
                  title="Profile cards"
                  entries={groupedEntries.profileCard}
                  emptyText="No profile cards yet."
                  renderEntry={renderVaultEntry}
                />
                <VaultResourceSection
                  debugId="vault-resource-section-agent-wallets"
                  title="Agent wallets"
                  entries={groupedEntries.stripeAgentWallet}
                  emptyText="No agent wallets yet."
                  renderEntry={renderVaultEntry}
                />
              </>
            )}
          </div>
        </>
      )}

      {workspaceTab === "grants" && (
        <VaultGrantsPanel
          grants={grants}
          busy={busy}
          onRefresh={() => void refresh()}
          onRevoke={(grantId) => void handleRevokeGrant(grantId)}
        />
      )}

      {workspaceTab === "setup" && (
        <VaultSetupPanel status={status} onRefresh={() => void refresh()} />
      )}
    </div>
  );

  function renderVaultEntry(entry: VaultKeyMeta): JSX.Element {
    const key = entry.key;
    const r = rowState[key] ?? {
      ...defaultRowState(),
    };
    const activeGrants = activeGrantsBySecretRef.get(key) ?? [];
    const permissionLevel = permissionLevelForEntry(entry, activeGrants);
    return (
      <VaultRow
        key={key}
        name={key}
        description={entry.description ?? entry.resourceSummary ?? null}
        resourceKind={resourceKindOf(entry)}
        resourceSummary={entry.resourceSummary ?? null}
        resourceProvider={entry.resourceProvider ?? null}
        resourceFields={entry.resourceFields ?? []}
        userOnly={Boolean(entry.userOnly)}
        permissionLevel={permissionLevel}
        activeGrantCount={activeGrants.length}
        busy={busy}
        row={r}
        onStartReplace={() => patchRow(key, { replacing: true, replaceValue: "" })}
        onChangeReplaceValue={(v) => patchRow(key, { replaceValue: v })}
        onGenerateReplaceValue={() => patchRow(key, { replaceValue: generateVaultPassword() })}
        onCancelReplace={() => patchRow(key, { replacing: false, replaceValue: "" })}
        onSubmitReplace={() => void handleReplace(key)}
        onCopyValue={(event) => void handleCopyValue(key, event)}
        onRevealValue={(event) => void handleRevealValue(key, event)}
        onHideReveal={() => patchRow(key, { revealValue: null })}
        onStartMetadataEdit={() =>
          patchRow(key, {
            editingMetadata: true,
            descriptionValue: entry.description ?? "",
            userOnlyValue: Boolean(entry.userOnly),
          })
        }
        onChangeDescriptionValue={(v) => patchRow(key, { descriptionValue: v })}
        onChangeUserOnlyValue={(v) => patchRow(key, { userOnlyValue: v })}
        onCancelMetadata={() => patchRow(key, { editingMetadata: false })}
        onSubmitMetadata={() => void handleUpdateMetadata(key)}
        onSetPermission={(level, event) => void handleSetPermission(entry, level, event)}
        onDeleteClick={() => void handleDelete(key)}
      />
    );
  }

  async function handleCopyGeneratedSecret(event?: ShellxUserEventLike): Promise<void> {
    if (!addValue) {
      setToast({ kind: "err", text: "Generate or enter a value first." });
      return;
    }
    if (!isTrustedShellxUserEvent(event)) {
      setToast({ kind: "err", text: "Copy requires a direct user click." });
      return;
    }
    try {
      await navigator.clipboard.writeText(addValue);
      setToast({ kind: "ok", text: "Copied generated value." });
    } catch {
      setToast({ kind: "err", text: "Clipboard blocked. Reveal and copy manually." });
    }
  }
}

/* ─────────────── Sub-components ─────────────── */

/**
 * Single secret row. The row collapses into "name + actions" until the
 * user opts into replace, at which point an inline password input slides
 * in below. Delete uses two-click confirmation — first click arms,
 * second click within 5s actually deletes.
 */
function VaultRow({
  name,
  description,
  resourceKind,
  resourceSummary,
  resourceProvider,
  resourceFields,
  userOnly,
  permissionLevel,
  activeGrantCount,
  busy,
  row,
  onStartReplace,
  onChangeReplaceValue,
  onGenerateReplaceValue,
  onCancelReplace,
  onSubmitReplace,
  onCopyValue,
  onRevealValue,
  onHideReveal,
  onStartMetadataEdit,
  onChangeDescriptionValue,
  onChangeUserOnlyValue,
  onCancelMetadata,
  onSubmitMetadata,
  onSetPermission,
  onDeleteClick,
}: {
  name: string;
  description: string | null;
  resourceKind: VaultResourceKind;
  resourceSummary: string | null;
  resourceProvider: string | null;
  resourceFields: string[];
  userOnly: boolean;
  permissionLevel: PermissionLevel;
  activeGrantCount: number;
  busy: boolean;
  row: RowState;
  onStartReplace: () => void;
  onChangeReplaceValue: (v: string) => void;
  onGenerateReplaceValue: () => void;
  onCancelReplace: () => void;
  onSubmitReplace: () => void;
  onCopyValue: (event?: MouseEvent<HTMLButtonElement>) => void;
  onRevealValue: (event?: MouseEvent<HTMLButtonElement>) => void;
  onHideReveal: () => void;
  onStartMetadataEdit: () => void;
  onChangeDescriptionValue: (v: string) => void;
  onChangeUserOnlyValue: (v: boolean) => void;
  onCancelMetadata: () => void;
  onSubmitMetadata: () => void;
  onSetPermission: (level: PermissionLevel, event?: MouseEvent<HTMLButtonElement>) => void;
  onDeleteClick: () => void;
}): JSX.Element {
  const canSubmitReplace = row.replaceValue.length > 0;
  const active = row.replacing || row.editingMetadata;
  return (
    <div className={`vault-row ${active ? "active" : ""}`} role="listitem">
      <div className="vault-row-head">
        <div style={{ minWidth: 0 }}>
          <span className="vault-key-name" title={name}>
            {name}
          </span>
          <div
            data-debug-id="vault-description-inline"
            className="vault-row-description"
            title={description ?? "No description"}
            style={{
              color: "var(--fg-muted)",
              fontSize: "var(--fs-ui-xs)",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {description?.trim() ? description : "No description"}
            {resourceKind !== "secret" && (
              <span className="vault-resource-kind" title={resourceKindTitle(resourceKind)}>
                {resourceKindTitle(resourceKind)}
              </span>
            )}
            {resourceProvider && (
              <span className="vault-resource-provider" title={`Provider: ${resourceProvider}`}>
                {resourceProvider}
              </span>
            )}
            {resourceSummary && (
              <span className="vault-resource-summary" title={resourceSummary}>
                {resourceSummary}
              </span>
            )}
            {resourceFields.length > 0 && (
              <span className="vault-resource-fields" title={resourceFields.join(", ")}>
                {resourceFields.length} field{resourceFields.length === 1 ? "" : "s"}
              </span>
            )}
            {activeGrantCount > 0 && (
              <span className="vault-grant-count" title={`${activeGrantCount} active agent grant${activeGrantCount === 1 ? "" : "s"}`}>
                {activeGrantCount} grant{activeGrantCount === 1 ? "" : "s"}
              </span>
            )}
            {userOnly && (
              <span
                className="vault-user-only-badge"
                style={{ marginLeft: 8, color: "var(--accent-warn, #d9a441)" }}
              >
                user-only
              </span>
            )}
          </div>
        </div>
        <PermissionBar
          level={permissionLevel}
          grantCount={activeGrantCount}
          disabled={busy}
          onChange={onSetPermission}
        />
        <div className="vault-row-actions">
          {!row.replacing && (
            <>
              <button
                type="button"
                className="settings-pill vault-action-copy"
                onClick={onCopyValue}
                aria-label={`Copy value for ${name}`}
                title="Copy value without revealing"
                disabled={busy}
              >
                <ShellIcon name="copy" size={13} />
              </button>
              <button
                type="button"
                className={`settings-pill vault-action-reveal ${row.revealValue !== null ? "active" : ""}`}
                onClick={onRevealValue}
                aria-label={row.revealValue !== null ? `Hide value for ${name}` : `Reveal value for ${name}`}
                title={row.revealValue !== null ? "Hide value" : "Reveal value"}
                disabled={busy}
              >
                <ShellIcon name={row.revealValue !== null ? "eye-off" : "eye"} size={13} />
              </button>
            </>
          )}
          {!row.replacing && (
            <button
              type="button"
              className="settings-pill vault-action-edit"
              onClick={onStartReplace}
              aria-label={`Replace value for ${name}`}
              title="Replace value"
            >
              <ShellIcon name="pencil" size={13} />
              <span>Replace</span>
            </button>
          )}
          {!row.editingMetadata && (
            <button
              type="button"
              className="settings-pill vault-action-metadata"
              onClick={onStartMetadataEdit}
              aria-label={`Edit metadata for ${name}`}
              title="Edit description and agent visibility"
            >
              Metadata
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
            {row.confirmingDelete ? "Delete?" : <ShellIcon name="trash" size={13} />}
          </button>
        </div>
      </div>
      {row.revealValue !== null && (
        <div className="vault-row-reveal" data-debug-id="vault-row-reveal">
          <input
            className="settings-input vault-revealed-value"
            value={row.revealValue}
            readOnly
            spellCheck={false}
            aria-label={`Revealed value for ${name}`}
          />
          <button type="button" className="settings-pill" onClick={onHideReveal} title="Hide value">
            <ShellIcon name="eye-off" size={13} />
          </button>
        </div>
      )}
      {row.editingMetadata && (
        <form
          className="vault-row-edit"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmitMetadata();
          }}
          style={{
            display: "flex",
            gap: "var(--space-2)",
            alignItems: "center",
            paddingTop: "var(--space-2)",
          }}
        >
          <textarea
            className="settings-input"
            data-debug-id="vault-description-input"
            placeholder="description visible to agents unless marked user-only"
            value={row.descriptionValue}
            onChange={(e) => onChangeDescriptionValue(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label={`Description for ${name}`}
            rows={2}
            style={{ flex: 1, resize: "vertical" }}
          />
          <label className="settings-pill" title="Hide this key name and description from agent planning lists">
            <input
              type="checkbox"
              data-debug-id="vault-user-only-toggle"
              checked={row.userOnlyValue}
              onChange={(e) => onChangeUserOnlyValue(e.target.checked)}
            />
            <span>User-only</span>
          </label>
          <button type="submit" className="settings-pill active">
            Save
          </button>
          <button type="button" className="settings-pill" onClick={onCancelMetadata}>
            <ShellIcon name="close" size={13} />
          </button>
        </form>
      )}
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
            type="button"
            className="settings-pill"
            onClick={onGenerateReplaceValue}
            title="Generate a strong replacement"
          >
            <ShellIcon name="sparkles" size={13} />
            <span>Generate</span>
          </button>
          <button
            type="submit"
            className={`settings-pill ${canSubmitReplace ? "active" : ""}`}
            disabled={!canSubmitReplace}
          >
            Save
          </button>
          <button type="button" className="settings-pill" onClick={onCancelReplace}>
            <ShellIcon name="close" size={13} />
          </button>
        </form>
      )}
    </div>
  );
}

function VaultResourceSection({
  debugId,
  title,
  entries,
  emptyText,
  renderEntry,
}: {
  debugId: string;
  title: string;
  entries: VaultKeyMeta[];
  emptyText: string;
  renderEntry: (entry: VaultKeyMeta) => JSX.Element;
}): JSX.Element {
  return (
    <section className="vault-resource-section" data-debug-id={debugId}>
      <div className="vault-resource-section-head">
        <h3>{title}</h3>
        <span>{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <div className="vault-empty">{emptyText}</div>
      ) : (
        entries.map((entry) => renderEntry(entry))
      )}
    </section>
  );
}

function SecretForm({
  keyName,
  value,
  valueVisible,
  description,
  userOnly,
  busy,
  canSubmit,
  generatorOpen,
  onChange,
  onOpenGenerator,
  onCloseGenerator,
  onUseGenerated,
  onSaveGenerated,
  onCopyGenerated,
  onSubmit,
}: {
  keyName: string;
  value: string;
  valueVisible: boolean;
  description: string;
  userOnly: boolean;
  busy: boolean;
  canSubmit: boolean;
  generatorOpen: boolean;
  onChange: (patch: Partial<{
    keyName: string;
    value: string;
    valueVisible: boolean;
    description: string;
    userOnly: boolean;
  }>) => void;
  onOpenGenerator: () => void;
  onCloseGenerator: () => void;
  onUseGenerated: (password: string, event?: MouseEvent<HTMLButtonElement>) => void;
  onSaveGenerated: (password: string, event?: MouseEvent<HTMLButtonElement>) => void;
  onCopyGenerated: (event?: MouseEvent<HTMLButtonElement>) => void;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <form
      className="vault-resource-form vault-add-row"
      data-debug-id="vault-secret-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      <h3>Secrets</h3>
      <div className="vault-resource-grid">
        <input
          type="text"
          className="settings-input"
          data-debug-id="vault-secret-key-input"
          placeholder="namespace/name (e.g. accounts/example-password)"
          value={keyName}
          onChange={(event) => onChange({ keyName: event.target.value })}
          spellCheck={false}
          autoComplete="off"
          aria-label="New secret key name"
        />
        <div className="vault-secret-value-control">
          <input
            type={valueVisible ? "text" : "password"}
            className="settings-input"
            data-debug-id="vault-secret-value-input"
            placeholder="value"
            value={value}
            onChange={(event) => onChange({ value: event.target.value })}
            spellCheck={false}
            autoComplete="off"
            aria-label="New secret value"
          />
          <button
            type="button"
            className="settings-pill"
            onClick={() => onChange({ valueVisible: !valueVisible })}
            aria-label={valueVisible ? "Hide generated secret value" : "Reveal generated secret value"}
            title={valueVisible ? "Hide value" : "Reveal value"}
          >
            <ShellIcon name={valueVisible ? "eye-off" : "eye"} size={13} />
          </button>
          <button
            type="button"
            className="settings-pill"
            data-debug-id="vault-generate-password"
            onClick={onOpenGenerator}
            title="Generate a strong password"
          >
            <ShellIcon name="sparkles" size={13} />
            <span>Generate</span>
          </button>
          <button
            type="button"
            className="settings-pill"
            onClick={onCopyGenerated}
            disabled={!value}
            title="Copy without revealing"
          >
            <ShellIcon name="copy" size={13} />
          </button>
        </div>
      </div>
      {generatorOpen && (
        <VaultPasswordGenerator
          title="Generate for this secret"
          onClose={onCloseGenerator}
          onUsePassword={onUseGenerated}
          usePasswordLabel="Use in field"
          onSavePassword={onSaveGenerated}
          savePasswordLabel="Save secret"
          savePasswordDisabled={!keyName.trim() || busy}
        />
      )}
      <textarea
        className="settings-input"
        data-debug-id="vault-description-input"
        placeholder="description visible to agents unless marked user-only"
        value={description}
        onChange={(event) => onChange({ description: event.target.value })}
        spellCheck={false}
        autoComplete="off"
        aria-label="New secret description"
        rows={2}
      />
      <div className="vault-resource-form-actions">
        <label className="settings-pill" title="Hide this key name and description from agent planning lists">
          <input
            type="checkbox"
            data-debug-id="vault-user-only-toggle"
            checked={userOnly}
            onChange={(event) => onChange({ userOnly: event.target.checked })}
          />
          <span>User-only</span>
        </label>
        <button
          type="submit"
          className={`settings-pill ${canSubmit ? "active" : ""}`}
          disabled={!canSubmit}
        >
          {busy ? "Saving…" : "Save secret"}
        </button>
      </div>
    </form>
  );
}

function ProfileCardForm({
  form,
  busy,
  onChange,
  onSubmit,
}: {
  form: {
    label: string;
    fullName: string;
    email: string;
    username: string;
    company: string;
    role: string;
    phone: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
    description: string;
    userOnly: boolean;
  };
  busy: boolean;
  onChange: (patch: Partial<typeof form>) => void;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <form
      className="vault-resource-form"
      data-debug-id="vault-profile-card-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h3>Profile cards</h3>
      <div className="vault-resource-grid">
        <input className="settings-input" placeholder="Card label" value={form.label} onChange={(event) => onChange({ label: event.target.value })} />
        <input className="settings-input" placeholder="Full name" value={form.fullName} onChange={(event) => onChange({ fullName: event.target.value })} autoComplete="name" />
        <input className="settings-input" placeholder="Email" value={form.email} onChange={(event) => onChange({ email: event.target.value })} autoComplete="email" />
        <input className="settings-input" placeholder="Username" value={form.username} onChange={(event) => onChange({ username: event.target.value })} autoComplete="username" />
        <input className="settings-input" placeholder="Company" value={form.company} onChange={(event) => onChange({ company: event.target.value })} autoComplete="organization" />
        <input className="settings-input" placeholder="Role" value={form.role} onChange={(event) => onChange({ role: event.target.value })} />
        <input className="settings-input" placeholder="Phone" value={form.phone} onChange={(event) => onChange({ phone: event.target.value })} autoComplete="tel" />
        <input className="settings-input" placeholder="Address line 1" value={form.addressLine1} onChange={(event) => onChange({ addressLine1: event.target.value })} autoComplete="address-line1" />
        <input className="settings-input" placeholder="Address line 2" value={form.addressLine2} onChange={(event) => onChange({ addressLine2: event.target.value })} autoComplete="address-line2" />
        <input className="settings-input" placeholder="City" value={form.city} onChange={(event) => onChange({ city: event.target.value })} autoComplete="address-level2" />
        <input className="settings-input" placeholder="Region" value={form.region} onChange={(event) => onChange({ region: event.target.value })} autoComplete="address-level1" />
        <input className="settings-input" placeholder="Postal code" value={form.postalCode} onChange={(event) => onChange({ postalCode: event.target.value })} autoComplete="postal-code" />
        <input className="settings-input" placeholder="Country" value={form.country} onChange={(event) => onChange({ country: event.target.value })} autoComplete="country-name" />
      </div>
      <textarea className="settings-input" placeholder="description visible to agents unless marked user-only" value={form.description} onChange={(event) => onChange({ description: event.target.value })} rows={2} />
      <div className="vault-resource-form-actions">
        <label className="settings-pill">
          <input type="checkbox" checked={form.userOnly} onChange={(event) => onChange({ userOnly: event.target.checked })} />
          <span>User-only</span>
        </label>
        <button type="submit" className="settings-pill active" disabled={busy || !form.label.trim()}>
          Save profile card
        </button>
      </div>
    </form>
  );
}

function AgentWalletForm({
  form,
  busy,
  onChange,
  onSubmit,
}: {
  form: {
    label: string;
    stripeMode: string;
    stripeApiKeyRef: string;
    webhookSecretRef: string;
    accountRef: string;
    cardholderRef: string;
    cardRef: string;
    budgetSummary: string;
    allowedOrigins: string;
    allowedCategories: string;
    status: string;
    description: string;
    userOnly: boolean;
  };
  busy: boolean;
  onChange: (patch: Partial<typeof form>) => void;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <form
      className="vault-resource-form"
      data-debug-id="vault-agent-wallet-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h3>Agent wallets</h3>
      <div className="vault-resource-grid">
        <input className="settings-input" placeholder="Wallet label" value={form.label} onChange={(event) => onChange({ label: event.target.value })} />
        <select className="settings-input" value={form.stripeMode} onChange={(event) => onChange({ stripeMode: event.target.value })}>
          <option value="test">Stripe test</option>
          <option value="live">Stripe live</option>
        </select>
        <input className="settings-input" placeholder="Stripe API secret ref" value={form.stripeApiKeyRef} onChange={(event) => onChange({ stripeApiKeyRef: event.target.value })} />
        <input className="settings-input" placeholder="Webhook signing secret ref" value={form.webhookSecretRef} onChange={(event) => onChange({ webhookSecretRef: event.target.value })} />
        <input className="settings-input" placeholder="Stripe account ref" value={form.accountRef} onChange={(event) => onChange({ accountRef: event.target.value })} />
        <input className="settings-input" placeholder="Stripe cardholder ref" value={form.cardholderRef} onChange={(event) => onChange({ cardholderRef: event.target.value })} />
        <input className="settings-input" placeholder="Stripe card ref" value={form.cardRef} onChange={(event) => onChange({ cardRef: event.target.value })} />
        <input className="settings-input" placeholder="Budget summary" value={form.budgetSummary} onChange={(event) => onChange({ budgetSummary: event.target.value })} />
        <input className="settings-input" placeholder="Allowed origins, comma-separated" value={form.allowedOrigins} onChange={(event) => onChange({ allowedOrigins: event.target.value })} />
        <input className="settings-input" placeholder="Allowed categories, comma-separated" value={form.allowedCategories} onChange={(event) => onChange({ allowedCategories: event.target.value })} />
        <select className="settings-input" value={form.status} onChange={(event) => onChange({ status: event.target.value })}>
          <option value="dryRun">Dry-run</option>
          <option value="active">Active</option>
          <option value="frozen">Frozen</option>
        </select>
      </div>
      <textarea className="settings-input" placeholder="description visible to agents unless marked user-only" value={form.description} onChange={(event) => onChange({ description: event.target.value })} rows={2} />
      <div className="vault-resource-form-actions">
        <label className="settings-pill">
          <input type="checkbox" checked={form.userOnly} onChange={(event) => onChange({ userOnly: event.target.checked })} />
          <span>User-only</span>
        </label>
        <button type="submit" className="settings-pill active" disabled={busy || !form.label.trim()}>
          Save wallet
        </button>
      </div>
    </form>
  );
}

function PermissionBar({
  level,
  grantCount,
  disabled,
  onChange,
}: {
  level: PermissionLevel;
  grantCount: number;
  disabled: boolean;
  onChange: (level: PermissionLevel, event?: MouseEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  return (
    <div
      className="vault-permission-bar"
      data-debug-id="vault-permission-bar"
      aria-label="Secret visibility and always-allowed use"
    >
      {PERMISSION_LEVELS.map((option) => (
        <button
          key={option.level}
          type="button"
          className={`vault-permission-choice ${level === option.level ? "active" : ""}`}
          data-debug-id={`vault-permission-${option.level}`}
          aria-pressed={level === option.level}
          title={option.title}
          disabled={disabled || level === option.level}
          onClick={(event) => onChange(option.level, event)}
        >
          {option.label}
        </button>
      ))}
      {grantCount > 0 && (
        <span className="vault-permission-count" title={`${grantCount} active grant${grantCount === 1 ? "" : "s"}`}>
          {grantCount}
        </span>
      )}
    </div>
  );
}

const PERMISSION_LEVELS: Array<{
  level: PermissionLevel;
  label: string;
  title: string;
}> = [
  {
    level: "userOnly",
    label: "User only",
    title: "Only the user can see this secret. Agents cannot see its name, description, or value.",
  },
  {
    level: "visible",
    label: "Visible / ask",
    title: "Agents can see safe metadata for planning and can ask to use this secret. Values stay hidden until approved.",
  },
  {
    level: "browserFillAlways",
    label: "Fill always",
    title: "Agents may use this resource through ShellX Browser fill flows without seeing the value.",
  },
  {
    level: "toolUseAlways",
    label: "Tool use always",
    title: "Agents may use this resource through mediated ShellX tools without raw reveal.",
  },
];

function permissionLevelForEntry(entry: VaultKeyMeta, activeGrants: GrantSummary[]): PermissionLevel {
  if (entry.userOnly) return "userOnly";
  const operations = new Set(
    activeGrants
      .map((grant) => normalizeGrantOperation(grant.operation))
      .filter((operation): operation is GrantOperation => Boolean(operation)),
  );
  if (
    operations.has("providerUse") ||
    operations.has("connectorUse") ||
    operations.has("injectEnv") ||
    operations.has("deposit")
  ) {
    return "toolUseAlways";
  }
  if (
    operations.has("fill") ||
    operations.has("profileFill") ||
    operations.has("emailCodeRead") ||
    operations.has("agentWalletUse")
  ) return "browserFillAlways";
  return "visible";
}

function desiredGrantOperationsForLevel(level: PermissionLevel, resourceKind: VaultResourceKind = "secret"): GrantOperation[] {
  switch (level) {
    case "browserFillAlways":
      switch (resourceKind) {
        case "profileCard":
          return ["profileFill"];
        case "emailInbox":
          return ["emailCodeRead"];
        case "stripeAgentWallet":
          return ["agentWalletUse"];
        case "secret":
          return ["fill"];
      }
    case "toolUseAlways":
      switch (resourceKind) {
        case "profileCard":
          return ["profileFill", "providerUse"];
        case "emailInbox":
          return ["emailCodeRead", "providerUse"];
        case "stripeAgentWallet":
          return ["agentWalletUse", "connectorUse"];
        case "secret":
          return ["fill", "providerUse"];
      }
    case "userOnly":
    case "visible":
      return [];
  }
}

function normalizeGrantOperation(operation: string): GrantOperation | null {
  switch (operation) {
    case "Fill":
    case "fill":
      return "fill";
    case "ProfileFill":
    case "profileFill":
      return "profileFill";
    case "EmailCodeRead":
    case "emailCodeRead":
      return "emailCodeRead";
    case "AgentWalletUse":
    case "agentWalletUse":
      return "agentWalletUse";
    case "InjectEnv":
    case "injectEnv":
      return "injectEnv";
    case "ProviderUse":
    case "providerUse":
      return "providerUse";
    case "ConnectorUse":
    case "connectorUse":
      return "connectorUse";
    case "Deposit":
    case "deposit":
      return "deposit";
    case "RawReveal":
    case "rawReveal":
      return "rawReveal";
    default:
      return null;
  }
}

function countActiveGrants(grants: GrantSummary[]): number {
  const now = Date.now();
  return grants.filter((grant) => grant.approved && !grant.revoked && (!grant.expiresAtMs || grant.expiresAtMs > now)).length;
}

function permissionLevelLabel(level: PermissionLevel): string {
  return PERMISSION_LEVELS.find((option) => option.level === level)?.label ?? level;
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

function descriptionOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resourceKindOf(entry: VaultKeyMeta): VaultResourceKind {
  switch (entry.resourceKind) {
    case "profileCard":
    case "stripeAgentWallet":
    case "secret":
      return entry.resourceKind;
    case "emailInbox":
      return "secret";
    default:
      return "secret";
  }
}

function resourceKindTitle(kind: VaultResourceKind): string {
  switch (kind) {
    case "profileCard":
      return "profile card";
    case "emailInbox":
      return "email inbox";
    case "stripeAgentWallet":
      return "agent wallet";
    case "secret":
      return "secret";
  }
}

function slug(value: string): string {
  const slugged = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slugged || "resource";
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function resourceFieldsFromObject(values: Record<string, string>): string[] {
  return Object.entries(values)
    .filter(([, value]) => value.trim().length > 0)
    .map(([key]) => key);
}

function profileResourceSummary(values: Record<string, string | boolean>): string {
  const fields = resourceFieldsFromObject({
    fullName: String(values.fullName ?? ""),
    email: String(values.email ?? ""),
    username: String(values.username ?? ""),
    company: String(values.company ?? ""),
    role: String(values.role ?? ""),
    phone: String(values.phone ?? ""),
    address: [
      values.addressLine1,
      values.addressLine2,
      values.city,
      values.region,
      values.postalCode,
      values.country,
    ]
      .map((value) => String(value ?? ""))
      .join(" "),
  });
  return fields.length > 0
    ? `Profile card fields: ${fields.join(", ")}`
    : "Profile card";
}
