/**
 * src/components/ConnectionEditor.tsx — saved-connection edit modal
 * .
 *
 * Mount in <PopoverRoot> next to .workspace chip in Header.tsx or as
 * a modal launched from ConnectionPicker's "+ New connection" CTA.
 * Until then, importable but NOT mounted in App.tsx — agent J's
 * UI-polish work will mount it once the layout converges.
 *
 * Form shape:
 * Label text, 1..64 chars
 * Transport radio: Local / WSL / SSH
 * Per-transport sub-fields
 * Local: grokPath (optional)
 * WSL: distro, grokPath
 * SSH: host (user@host), port?, keyVaultRef?,
 * remoteGrokPath
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
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ConnectionPreset, TransportSpec, TestResult } from "./ConnectionPicker";

/* open a Tauri file picker and resolve to a string path.
 * Used by the Browse… buttons next to Local + WSL grok-path fields.
 * Falls through silently when not running inside Tauri (browser mode). */
async function pickFilePath(opts: { title: string }): Promise<string | null> {
  try {
    const picked = await openDialog({ multiple: false, directory: false, title: opts.title });
    if (typeof picked === "string" && picked.trim()) return picked;
    return null;
  } catch {
    return null;
  }
}

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
  const [localGrokPath, setLocalGrokPath] = useState("");
  const [wslDistro, setWslDistro] = useState("");
  const [wslGrokPath, setWslGrokPath] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState<string>("");
  const [sshRemoteGrokPath, setSshRemoteGrokPath] = useState("");
  const [sshKeyVaultRef, setSshKeyVaultRef] = useState<string>("");
 // Vault key dropdown content.
  const [vaultKeys, setVaultKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

 // Hydrate fields when editing an existing preset.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTestResult(null);
    if (initial) {
      setLabel(initial.label);
      setKind(initial.transport.kind as "local" | "wsl" | "ssh");
      if (initial.transport.kind === "local") {
        setLocalGrokPath(initial.transport.grokPath ?? "");
      }
      if (initial.transport.kind === "wsl") {
        setWslDistro(initial.transport.distro);
        setWslGrokPath(initial.transport.grokPath);
      }
      if (initial.transport.kind === "ssh") {
        setSshHost(initial.transport.host);
        setSshPort(initial.transport.port?.toString() ?? "");
        setSshRemoteGrokPath(initial.transport.remoteGrokPath);
        setSshKeyVaultRef(initial.transport.keyVaultRef ?? "");
      }
    } else {
      setLabel("");
      setKind("local");
      setLocalGrokPath("");
      setWslDistro("");
      setWslGrokPath("");
      setSshHost("");
      setSshPort("");
      setSshRemoteGrokPath("");
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
      return localGrokPath.trim()
        ? { kind: "local", grokPath: localGrokPath.trim() }
        : { kind: "local" };
    }
    if (kind === "wsl") {
      if (!wslDistro.trim()) return "WSL distro required";
      if (!wslGrokPath.trim()) return "WSL grok path required";
      return {
        kind: "wsl",
        distro: wslDistro.trim(),
        grokPath: wslGrokPath.trim(),
      };
    }
    if (!sshHost.trim()) return "SSH host required";
    if (!sshRemoteGrokPath.trim()) return "Remote grok path required";
    const portNum = sshPort.trim() ? Number(sshPort.trim()) : undefined;
    if (portNum !== undefined && (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535)) {
      return "SSH port must be 1..65535";
    }
    const t: TransportSpec = {
      kind: "ssh",
      host: sshHost.trim(),
      remoteGrokPath: sshRemoteGrokPath.trim(),
    };
    if (portNum !== undefined) t.port = portNum;
    if (sshKeyVaultRef) t.keyVaultRef = sshKeyVaultRef;
    return t;
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
      const preset: ConnectionPreset = initial
        ? { ...initial, label: label.trim(), transport: tr }
        : {
            id: "",
            label: label.trim(),
            transport: tr,
            createdMs: 0,
            lastUsedMs: 0,
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
          width: 480,
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
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="megaclub"
            style={inputStyle}
          />
        </Labeled>
        <Labeled label="Transport">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {(["local", "wsl", "ssh"] as const).map((k) => (
              <label key={k} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <input
                  type="radio"
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
        {kind === "local" && (
          <Labeled label="Grok path (optional)">
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                value={localGrokPath}
                onChange={(e) => setLocalGrokPath(e.target.value)}
                placeholder="(blank = platform default)"
                style={{ ...inputStyle, flex: 1 }}
              />
 {/* Browse… picks the local grok binary via
 * the native file dialog. Hidden when running outside
 * Tauri (the picker just no-ops in that case). */}
              <button
                type="button"
                onClick={async () => {
                  const p = await pickFilePath({ title: "Pick grok executable" });
                  if (p) setLocalGrokPath(p);
                }}
                style={browseBtnStyle}
                title="Pick the grok executable on this machine"
              >
                Browse…
              </button>
            </div>
          </Labeled>
        )}
        {kind === "wsl" && (
          <>
            <Labeled label="WSL distro">
              <input
                type="text"
                value={wslDistro}
                onChange={(e) => setWslDistro(e.target.value)}
                placeholder="Ubuntu-24.04"
                style={inputStyle}
              />
            </Labeled>
            <Labeled label="Grok path inside WSL">
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text"
                  value={wslGrokPath}
                  onChange={(e) => setWslGrokPath(e.target.value)}
                  placeholder="/home/<user>/.grok/bin/grok"
                  style={{ ...inputStyle, flex: 1 }}
                />
 {/* Browse… resolves via Tauri's file
 * picker against the \\wsl$\<distro>\... UNC mount
 * on Windows. The returned Windows-style path is
 * translated to a Linux path string by stripping the
 * UNC prefix. On Linux/WSL itself the dialog just
 * returns the absolute Linux path. */}
                <button
                  type="button"
                  onClick={async () => {
                    const p = await pickFilePath({ title: "Pick grok inside WSL" });
                    if (!p) return;
 // Strip a leading \\wsl$\<distro>\ or \\wsl.localhost\<distro>\
 // prefix that Windows file pickers return when the user
 // navigates into a WSL distro. Yields a clean Linux path.
                    const m = p.match(/^\\\\wsl(\$|\.localhost)\\[^\\]+(\\.+)$/);
                    const linuxPath = m && m[2] ? m[2].replace(/\\/g, "/") : p;
                    setWslGrokPath(linuxPath);
                  }}
                  style={browseBtnStyle}
                  title="Pick the grok executable inside WSL"
                >
                  Browse…
                </button>
              </div>
            </Labeled>
          </>
        )}
        {kind === "ssh" && (
          <>
            <Labeled label="Host">
              <input
                type="text"
                value={sshHost}
                onChange={(e) => setSshHost(e.target.value)}
                placeholder="user@megaclub"
                style={inputStyle}
              />
            </Labeled>
            <Labeled label="Port (optional, default 22)">
              <input
                type="number"
                value={sshPort}
                onChange={(e) => setSshPort(e.target.value)}
                placeholder="22"
                min={1}
                max={65535}
                style={inputStyle}
              />
            </Labeled>
            <Labeled label="Remote grok path">
              <input
                type="text"
                value={sshRemoteGrokPath}
                onChange={(e) => setSshRemoteGrokPath(e.target.value)}
                placeholder="/home/user/.grok/bin/grok"
                style={inputStyle}
              />
            </Labeled>
            <Labeled label="Key vault ref (optional)">
              <select
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
