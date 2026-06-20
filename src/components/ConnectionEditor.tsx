/**
 * src/components/ConnectionEditor.tsx — saved-connection edit modal
 * .
 *
 * Mounted from the composer connection picker and the Settings →
 * Connections tab.
 *
 * Form shape:
 * Label text, 1..64 chars
 * Transport radio: Local / WSL / SSH
 * Per-transport sub-fields
 * Local: no extra fields; agent CLIs are discovered by scan.
 * WSL: distro; agent CLIs are discovered by scan.
 * SSH: host (user@host), port?, keyVaultRef?; agent CLIs are discovered by scan.
 * "Save" → connections_save(preset)
 * "Test" → connections_test(id) — only enabled after first save
 *
 * Backend wiring:
 * - invoke("connections_save", {preset}) → ConnectionPreset
 * - invoke("connections_test", {id}) → TestResult
 *
 * The keyVaultRef field is rendered as a "pick vault key" dropdown
 * sourced from invoke("vault_list_keys", {prefix:"connections."}).
 * Selecting "(none)" clears the field. We DO NOT expose vault values
 * here — only the references.
 */
import { useEffect, useState, type CSSProperties, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionPreset,
  ConnectionProviderScanEntry,
  TransportSpec,
  TestResult,
} from "./ConnectionPicker";
import { agentDisplayName } from "../lib/agent-selection";
import { AgentCliSetupDialog } from "./AgentCliSetupAssistant";

export function ConnectionEditor({
  open,
  initial,
  onSaved,
  onClose,
}: {
  open: boolean;
 /** When set, edit existing; when undefined, create new. */
  initial?: ConnectionPreset;
  onSaved: (saved: ConnectionPreset) => void;
  onClose: () => void;
}): JSX.Element | null {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"local" | "wsl" | "ssh">("local");
 // Per-transport fields — each kept independent so switching the
 // radio doesn't blow away unrelated input.
  const [wslDistro, setWslDistro] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState<string>("");
  const [sshKeyVaultRef, setSshKeyVaultRef] = useState<string>("");
 // Vault key dropdown content.
  const [vaultKeys, setVaultKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [providerScan, setProviderScan] = useState<{
    transport: "local" | "wsl" | "ssh";
    wslDistro?: string;
    sshHost?: string;
    transportSignature: string;
    providers: ConnectionProviderScanEntry[];
    checkedAtMs: number;
  } | null>(null);
  const [lastProviderScan, setLastProviderScan] = useState<ConnectionProviderScanEntry[]>([]);
  const [lastProviderScanSignature, setLastProviderScanSignature] = useState<string | null>(null);
  const [providerScanning, setProviderScanning] = useState(false);
  const [providerScanError, setProviderScanError] = useState<string | null>(null);
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);

 // Hydrate fields when editing an existing preset.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTestResult(null);
    setProviderScan(null);
    setProviderScanError(null);
    setSetupDialogOpen(false);
    setLastProviderScan(initial?.providerScan ?? []);
    setLastProviderScanSignature(initial ? transportSignature(initial.transport) : null);
    if (initial) {
      setLabel(initial.label);
      setKind(initial.transport.kind as "local" | "wsl" | "ssh");
      if (initial.transport.kind === "wsl") {
        setWslDistro(initial.transport.distro);
      }
      if (initial.transport.kind === "ssh") {
        setSshHost(initial.transport.host);
        setSshPort(initial.transport.port?.toString() ?? "");
        setSshKeyVaultRef(initial.transport.keyVaultRef ?? "");
      }
    } else {
      setLabel("");
      setKind("local");
      setWslDistro("");
      setSshHost("");
      setSshPort("");
      setSshKeyVaultRef("");
    }
 // Always refresh vault key list when the modal opens.
    invoke<string[]>("vault_list_keys", { prefix: "connections." })
      .then(setVaultKeys)
      .catch(() => setVaultKeys([]));
  }, [open, initial]);

  if (!open) return null;

  function buildTransport(): TransportSpec | string {
    if (kind === "local") {
      return { kind: "local" };
    }
    if (kind === "wsl") {
      if (!wslDistro.trim()) return "WSL distro required";
      return {
        kind: "wsl",
        distro: wslDistro.trim(),
        grokPath: "",
      };
    }
    if (!sshHost.trim()) return "SSH host required";
    const portNum = sshPort.trim() ? Number(sshPort.trim()) : undefined;
    if (portNum !== undefined && (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535)) {
      return "SSH port must be 1..65535";
    }
    const t: TransportSpec = {
      kind: "ssh",
      host: sshHost.trim(),
      remoteGrokPath: "grok",
    };
    if (portNum !== undefined) t.port = portNum;
    if (sshKeyVaultRef) t.keyVaultRef = sshKeyVaultRef;
    return t;
  }

  const currentTransportSignature = (() => {
    const tr = buildTransport();
    return typeof tr === "string" ? null : transportSignature(tr);
  })();
  const currentProviderScan = currentTransportSignature === lastProviderScanSignature
    ? lastProviderScan
    : [];
  const setupPreset = (() => {
    const tr = buildTransport();
    if (typeof tr === "string") return null;
    return {
      id: initial?.id ?? "",
      label: label.trim() || initial?.label || "draft connection",
      transport: tr,
      createdMs: initial?.createdMs ?? Date.now(),
      lastUsedMs: initial?.lastUsedMs ?? 0,
      providerScan: currentProviderScan,
    } satisfies ConnectionPreset;
  })();

  function applySetupScan(providers: ConnectionProviderScanEntry[]) {
    const tr = buildTransport();
    if (typeof tr === "string") return;
    const sig = transportSignature(tr);
    const checkedAtMs = providers[0]?.checkedAtMs ?? Date.now();
    setLastProviderScan(providers);
    setLastProviderScanSignature(sig);
    setProviderScan({
      transport: kind,
      wslDistro: kind === "wsl" ? wslDistro.trim() : undefined,
      sshHost: kind === "ssh" ? sshHost.trim() : undefined,
      transportSignature: sig,
      providers,
      checkedAtMs,
    });
  }

  async function handleSave() {
    if (!label.trim()) {
      setError("label required");
      return;
    }
    const tr = buildTransport();
    if (typeof tr === "string") {
      setError(tr);
      return;
    }
    setSaving(true);
    try {
      const providerScanForSave = transportSignature(tr) === lastProviderScanSignature
        ? lastProviderScan
        : [];
      const preset: ConnectionPreset = initial
        ? { ...initial, label: label.trim(), transport: tr, providerScan: providerScanForSave }
        : {
            id: "",
            label: label.trim(),
            transport: tr,
            createdMs: 0,
            lastUsedMs: 0,
            providerScan: providerScanForSave,
          };
      const saved = await invoke<ConnectionPreset>("connections_save", { preset });
      onSaved(saved);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!initial?.id) {
      setError("save the preset first to enable Test");
      return;
    }
    setTesting(true);
    try {
      const r = await invoke<TestResult>("connections_test", { id: initial.id });
      setTestResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  }

  async function handleProviderScan() {
    setProviderScanError(null);
    setProviderScan(null);
    const tr = buildTransport();
    if (typeof tr === "string") {
      setProviderScanError(tr);
      return;
    }
    setProviderScanning(true);
    try {
      const transportSignatureForScan = transportSignature(tr);
      const draft: ConnectionPreset = {
        id: initial?.id ?? "",
        label: label.trim() || initial?.label || "draft connection",
        transport: tr,
        createdMs: initial?.createdMs ?? Date.now(),
        lastUsedMs: initial?.lastUsedMs ?? 0,
        providerScan: currentProviderScan,
      };
      const providers = await invoke<ConnectionProviderScanEntry[]>("connection_provider_scan", { preset: draft });
      const checkedAtMs = providers[0]?.checkedAtMs ?? Date.now();
      setLastProviderScan(providers);
      setLastProviderScanSignature(transportSignatureForScan);
      setProviderScan({
        transport: kind,
        wslDistro: kind === "wsl" ? wslDistro.trim() : undefined,
        sshHost: kind === "ssh" ? sshHost.trim() : undefined,
        transportSignature: transportSignatureForScan,
        providers,
        checkedAtMs,
      });
    } catch (e) {
      setProviderScanError(String(e));
    } finally {
      setProviderScanning(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="conn-editor-title"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 950,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-elev, #111)",
          color: "var(--fg, #eee)",
          border: "1px solid var(--border, #333)",
          borderRadius: 8,
          padding: 20,
          width: "min(720px, calc(100vw - 32px))",
          maxHeight: "min(900px, calc(100vh - 32px))",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 id="conn-editor-title" style={{ margin: 0, fontSize: 16 }}>
            {initial ? "Edit connection" : "New connection"}
          </h2>
          <button onClick={onClose}>×</button>
        </div>
        {error && (
          <div role="alert" style={{ color: "#f55", fontSize: "var(--fs-ui-sm)" }}>
            {error}
          </div>
        )}
        <Labeled label="Label">
          <input
            type="text"
            data-debug-id="connection-label-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="prod-server"
            style={inputStyle}
          />
        </Labeled>
        <Labeled label="Transport">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {(["local", "wsl", "ssh"] as const).map((k) => (
              <label key={k} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <input
                  type="radio"
                  data-debug-id={`connection-transport-${k}`}
                  name="transport"
                  value={k}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                {k.toUpperCase()}
              </label>
            ))}
          </div>
        </Labeled>
        {kind === "wsl" && (
          <>
            <Labeled label="WSL distro">
              <input
                type="text"
                data-debug-id="connection-wsl-distro-input"
                value={wslDistro}
                onChange={(e) => setWslDistro(e.target.value)}
                placeholder="Ubuntu-24.04"
                style={inputStyle}
              />
            </Labeled>
          </>
        )}
        {kind === "ssh" && (
          <>
            <Labeled label="Host">
              <input
                type="text"
                data-debug-id="connection-ssh-host-input"
                value={sshHost}
                onChange={(e) => setSshHost(e.target.value)}
                placeholder="user@example-host"
                style={inputStyle}
              />
            </Labeled>
            <Labeled label="Port (optional, default 22)">
              <input
                type="number"
                data-debug-id="connection-ssh-port-input"
                value={sshPort}
                onChange={(e) => setSshPort(e.target.value)}
                placeholder="22"
                min={1}
                max={65535}
                style={inputStyle}
              />
            </Labeled>
            <Labeled label="Key vault ref (optional)">
              <select
                data-debug-id="connection-ssh-key-select"
                value={sshKeyVaultRef}
                onChange={(e) => setSshKeyVaultRef(e.target.value)}
                style={inputStyle}
              >
                <option value="">(use ssh-agent / ssh-config default)</option>
                {vaultKeys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </Labeled>
          </>
        )}
        <Labeled label="Agent CLIs in this environment">
          <div style={providerScanBoxStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <div style={{ fontSize: "var(--fs-ui-sm)", color: "var(--ink-2)" }}>
                {kind === "ssh"
                  ? "Scan installed agent CLIs through this SSH connection."
                  : kind === "wsl"
                    ? "Scan installed agent CLIs inside this WSL distro."
                    : "Scan installed agent CLIs on this machine."}
              </div>
              <button
                type="button"
                onClick={() => void handleProviderScan()}
                disabled={providerScanning}
                style={browseBtnStyle}
              >
                {providerScanning ? "Scanning..." : "Scan CLIs"}
              </button>
            </div>
            {providerScanError && (
              <div role="alert" style={{ color: "#f88", fontSize: "var(--fs-ui-sm)" }}>
                {providerScanError}
              </div>
            )}
            {providerScan && (
              <div style={providerScanListStyle}>
                {providerScan.providers.map((provider) => (
                  <div key={provider.providerId} style={providerScanRowStyle}>
                    <span style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: provider.canRun ? "#79d58b" : "#777",
                      flex: "0 0 auto",
                    }} />
                    <span style={{ flex: 1 }}>
                      <strong>{agentDisplayName(provider.providerId)}</strong>
                      <span style={{ color: "var(--ink-3)", marginLeft: 6 }}>
                        {provider.canRun
                          ? provider.version ?? provider.binary ?? "ready"
                          : "missing CLI"}
                      </span>
                    </span>
                  </div>
                ))}
                <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-ui-sm)" }}>
                  Checked {new Date(providerScan.checkedAtMs).toLocaleTimeString()}
                  {providerScan.transport === "wsl"
                    ? ` · WSL ${providerScan.wslDistro}`
                    : providerScan.transport === "ssh"
                      ? ` · SSH ${providerScan.sshHost}`
                      : " · Local"}
                </div>
              </div>
            )}
            {!providerScan && currentProviderScan.length > 0 && (
              <div style={providerScanListStyle}>
                {currentProviderScan.map((provider) => (
                  <div key={provider.providerId} style={providerScanRowStyle}>
                    <span style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: provider.canRun ? "#79d58b" : "#777",
                      flex: "0 0 auto",
                    }} />
                    <span style={{ flex: 1 }}>
                      <strong>{agentDisplayName(provider.providerId)}</strong>
                      <span style={{ color: "var(--ink-3)", marginLeft: 6 }}>
                        {provider.canRun
                          ? provider.version ?? provider.binary ?? "ready"
                          : "missing CLI"}
                      </span>
                    </span>
                  </div>
                ))}
                <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-ui-sm)" }}>
                  Last saved scan {new Date(Math.max(...currentProviderScan.map((p) => p.checkedAtMs))).toLocaleTimeString()}
                </div>
              </div>
            )}
            {setupPreset && (providerScan || currentProviderScan.length > 0) && (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  data-debug-id="connection-agent-cli-setup-open"
                  onClick={() => setSetupDialogOpen(true)}
                  style={browseBtnStyle}
                >
                  Set up CLIs
                </button>
              </div>
            )}
          </div>
        </Labeled>
        {setupDialogOpen && setupPreset && (
          <AgentCliSetupDialog
            preset={setupPreset}
            onSetupChanged={applySetupScan}
            onClose={() => setSetupDialogOpen(false)}
          />
        )}
        {testResult && (
          <div
            role="status"
            style={{
              fontSize: "var(--fs-ui-sm)",
              color: testResult.reachable ? "#7c7" : "#f88",
              background: "rgba(255,255,255,0.04)",
              padding: 6,
              borderRadius: 4,
            }}
          >
            {testResult.reachable
              ? `Reachable (${testResult.latencyMs ?? "?"}ms)`
              : `Unreachable: ${testResult.error ?? "unknown"}`}
          </div>
        )}
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 6 }}>
          <button onClick={handleTest} disabled={testing || !initial?.id}>
            {testing ? "Testing…" : "Test"}
          </button>
          <button onClick={onClose}>Cancel</button>
          <button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
      <span style={{ color: "var(--fg-muted, #888)" }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle: CSSProperties = {
  padding: 6,
  background: "transparent",
  border: "1px solid #333",
  color: "inherit",
  fontFamily: "var(--mono, monospace)",
  fontSize: "var(--fs-ui-sm)",
};

const browseBtnStyle: CSSProperties = {
  padding: "6px 10px",
  background: "transparent",
  border: "1px solid #333",
  color: "inherit",
  fontSize: 12,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const providerScanBoxStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 10,
  border: "1px solid #333",
  borderRadius: 6,
  background: "rgba(255,255,255,0.025)",
};

const providerScanListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const providerScanRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: "var(--fs-ui-sm)",
};

function transportSignature(transport: TransportSpec): string {
  switch (transport.kind) {
    case "local":
      return ["local", transport.grokPath ?? ""].join("|");
    case "wsl":
      return ["wsl", transport.distro, transport.grokPath ?? ""].join("|");
    case "ssh":
      return [
        "ssh",
        transport.host,
        transport.port?.toString() ?? "",
        transport.keyVaultRef ?? "",
        transport.remoteGrokPath ?? "",
      ].join("|");
    case "ws_direct":
      return ["ws_direct", transport.url, transport.secretVaultRef ?? ""].join("|");
    case "ws_tunnel":
      return ["ws_tunnel", transport.url, transport.secretVaultRef ?? ""].join("|");
    case "tailscale":
      return ["tailscale", transport.tailnetHost, transport.port?.toString() ?? ""].join("|");
  }
}
