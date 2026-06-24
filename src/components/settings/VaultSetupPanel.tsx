import { useEffect, useRef, useState, type ChangeEvent, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";

type SetupMode = "local" | "external";

type VaultStatus = {
  mode?: string;
  unlocked?: boolean;
  recoveryConfirmed?: boolean;
  rememberedDeviceEnabled?: boolean;
  lastError?: string | null;
};

type RecoveryKit = {
  confirmationId: string;
  words: string[];
  warning: string;
};

type LegacyImportReceipt = {
  importedKeys: number;
  skipped: boolean;
};

export function VaultSetupPanel({
  status,
  onRefresh,
}: {
  status: VaultStatus | null;
  onRefresh: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<SetupMode>("local");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [repo, setRepo] = useState("default");
  const [token, setToken] = useState("");
  const [keyfileJson, setKeyfileJson] = useState("");
  const [selectedKeyfileName, setSelectedKeyfileName] = useState("");
  const [rememberDevice, setRememberDevice] = useState(true);
  const [rememberPassphrase, setRememberPassphrase] = useState("");
  const [recoveryKit, setRecoveryKit] = useState<RecoveryKit | null>(null);
  const [importLegacy, setImportLegacy] = useState(false);
  const [showSetupForm, setShowSetupForm] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const keyfileInputRef = useRef<HTMLInputElement | null>(null);

  const passphrasesMatch = passphrase.length > 0 && passphrase === confirmPassphrase;
  const passphraseMismatch = confirmPassphrase.length > 0 && passphrase !== confirmPassphrase;
  const canBegin =
    passphrasesMatch &&
    (mode === "local" || (serverUrl.trim().length > 0 && token.trim().length > 0));
  const canUnlock =
    status?.recoveryConfirmed === true &&
    status?.unlocked !== true &&
    passphrase.trim().length > 0;
  const showingConfiguredSummary =
    status?.recoveryConfirmed === true &&
    !recoveryKit &&
    !showSetupForm;

  useEffect(() => {
    setRememberDevice(status?.rememberedDeviceEnabled ?? true);
  }, [status?.rememberedDeviceEnabled]);

  async function beginSetup(): Promise<void> {
    if (passphrase !== confirmPassphrase) {
      setMessage("passphrases do not match");
      return;
    }
    if (!canBegin || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const kit = await invoke<RecoveryKit>("shellx_vault_begin_setup", {
        request: {
          target: mode,
          passphrase,
          serverUrl: mode === "external" ? serverUrl.trim() : null,
          repo: repo.trim() || "default",
          token: mode === "external" ? token.trim() : null,
          keyfileJson: keyfileJson.trim() || null,
          rememberDevice,
        },
      });
      setRecoveryKit(kit);
      setPassphrase("");
      setConfirmPassphrase("");
      setMessage(kit.warning);
    } catch (err) {
      setMessage(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRecovery(): Promise<void> {
    if (!recoveryKit?.confirmationId || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const receipt = await invoke<LegacyImportReceipt>("shellx_vault_confirm_recovery_saved", {
        confirmationId: recoveryKit.confirmationId,
        importLegacy,
      });
      setPassphrase("");
      setConfirmPassphrase("");
      setToken("");
      setKeyfileJson("");
      setSelectedKeyfileName("");
      setRecoveryKit(null);
      setMessage(
        receipt.skipped
          ? "Recovery confirmed. Vault is ready without imported ShellX secrets."
          : `Recovery confirmed. Imported ${receipt.importedKeys} ShellX secrets.`,
      );
      onRefresh();
    } catch (err) {
      setMessage(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function unlockVault(): Promise<void> {
    if (!canUnlock || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await invoke("shellx_vault_unlock", {
        request: {
          passphrase,
          keyfileJson: keyfileJson.trim() || null,
          rememberDevice,
        },
      });
      setPassphrase("");
      setKeyfileJson("");
      setSelectedKeyfileName("");
      setMessage("");
      onRefresh();
    } catch (err) {
      setMessage(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function setRememberedDevice(enabled: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await invoke("shellx_vault_set_remembered_device_enabled", {
        enabled,
        passphrase: enabled ? rememberPassphrase : null,
      });
      setRememberPassphrase("");
      setRememberDevice(enabled);
      onRefresh();
    } catch (err) {
      setMessage(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyRecoveryKit(): Promise<void> {
    if (!recoveryKit?.words.length) return;
    try {
      await navigator.clipboard.writeText(recoveryKit.words.join(" "));
      setMessage("Recovery words copied. Keep them offline and private.");
    } catch {
      setMessage("Clipboard blocked. Select and copy the recovery words manually.");
    }
  }

  async function handleKeyfileFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setMessage("");
    try {
      if (file.size > 16 * 1024) {
        setMessage("Selected keyfile is too large.");
        return;
      }
      const raw = (await file.text()).trim();
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setMessage("Selected file is not a Vault keyfile JSON.");
        return;
      }
      setKeyfileJson(raw);
      setSelectedKeyfileName(file.name);
      setMessage("Existing keyfile selected.");
    } catch {
      setKeyfileJson("");
      setSelectedKeyfileName("");
      setMessage("Selected file is not valid JSON.");
    }
  }

  function clearSelectedKeyfile(): void {
    setKeyfileJson("");
    setSelectedKeyfileName("");
    setMessage("");
  }

  return (
    <section
      className="vault-setup-panel"
      data-debug-id="shellx-vault-setup"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="vault-panel-head">
        <strong>Vault setup</strong>
        <span>{status?.mode ?? "unconfigured"}</span>
      </div>
      {status?.lastError && (
        <p className="vault-hint vault-profile-collision" data-debug-id="vault-profile-collision">
          {status.lastError}
        </p>
      )}
      {showingConfiguredSummary ? (
        <div className="vault-configured-summary" data-debug-id="shellx-vault-configured-summary">
          <div>
            <strong>Vault configured</strong>
            <span>
              {status?.unlocked ? "Unlocked on this device." : "Configured; unlock is required before secret use."}
            </span>
          </div>
          {!status?.unlocked && (
            <form
              className="vault-setup-grid"
              data-debug-id="shellx-vault-unlock-form"
              onSubmit={(event) => {
                event.preventDefault();
                void unlockVault();
              }}
            >
              <input
                className="settings-input"
                data-debug-id="shellx-vault-unlock-passphrase"
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder="Master passphrase"
                autoComplete="current-password"
              />
              <button
                type="submit"
                className={`settings-pill ${canUnlock ? "active" : ""}`}
                data-debug-id="shellx-vault-unlock"
                disabled={!canUnlock || busy}
              >
                Unlock vault
              </button>
              <label className="vault-check-row" title="Use OS device credentials to unlock this Vault on this computer">
                <input
                  type="checkbox"
                  data-debug-id="shellx-vault-remember-device-unlock"
                  checked={rememberDevice}
                  onChange={(event) => setRememberDevice(event.currentTarget.checked)}
                />
                Remember this device
              </label>
            </form>
          )}
          {status?.unlocked && (
            <div className="vault-remember-device-control">
              {status.rememberedDeviceEnabled ? (
                <button
                  type="button"
                  className="settings-pill active"
                  data-debug-id="shellx-vault-forget-device"
                  onClick={() => void setRememberedDevice(false)}
                  disabled={busy}
                >
                  Forget this device
                </button>
              ) : (
                <>
                  <input
                    className="settings-input"
                    data-debug-id="shellx-vault-remember-passphrase"
                    type="password"
                    value={rememberPassphrase}
                    onChange={(event) => setRememberPassphrase(event.target.value)}
                    placeholder="Master passphrase"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className={`settings-pill ${rememberPassphrase.trim() ? "active" : ""}`}
                    data-debug-id="shellx-vault-remember-device-enable"
                    onClick={() => void setRememberedDevice(true)}
                    disabled={!rememberPassphrase.trim() || busy}
                  >
                    Remember this device
                  </button>
                </>
              )}
            </div>
          )}
          <button
            type="button"
            className="settings-pill"
            data-debug-id="shellx-vault-change-setup"
            onClick={() => setShowSetupForm(true)}
            disabled={busy}
          >
            Change setup
          </button>
        </div>
      ) : (
        <>
          <div className="vault-segmented-control" data-debug-id="shellx-vault-setup-mode">
            <button
              type="button"
              aria-pressed={mode === "local"}
              onClick={() => setMode("local")}
            >
              Local
            </button>
            <button
              type="button"
              aria-pressed={mode === "external"}
              onClick={() => setMode("external")}
            >
              External
            </button>
          </div>
          {mode === "external" && (
            <div className="vault-setup-grid">
              <input
                className="settings-input"
                type="url"
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder="Server URL"
                autoComplete="off"
              />
              <input
                className="settings-input"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="Repo"
                autoComplete="off"
              />
              <input
                className="settings-input"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Access token"
                autoComplete="off"
              />
            </div>
          )}
          <div className="vault-setup-grid">
            <input
              className="settings-input"
              data-debug-id="shellx-vault-master-passphrase"
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder="Master passphrase"
              autoComplete="new-password"
            />
            <input
              className="settings-input"
              data-debug-id="shellx-vault-confirm-passphrase"
              type="password"
              value={confirmPassphrase}
              onChange={(event) => setConfirmPassphrase(event.target.value)}
              placeholder="Confirm master passphrase"
              autoComplete="new-password"
            />
            <div className="vault-keyfile-picker">
              <input
                ref={keyfileInputRef}
                data-debug-id="shellx-vault-keyfile-file"
                type="file"
                accept="application/json,.json"
                onChange={(event) => void handleKeyfileFile(event)}
                hidden
              />
              <button
                type="button"
                className={`settings-pill ${keyfileJson ? "active" : ""}`}
                onClick={() => keyfileInputRef.current?.click()}
                disabled={busy}
              >
                {keyfileJson ? "Change keyfile" : "Use existing keyfile"}
              </button>
              {selectedKeyfileName && <span>{selectedKeyfileName}</span>}
              {keyfileJson && (
                <button
                  type="button"
                  className="settings-pill"
                  onClick={clearSelectedKeyfile}
                  disabled={busy}
                >
                  Clear
                </button>
              )}
            </div>
            <div className="vault-setup-actions">
              <button
                type="button"
                className={`settings-pill ${canBegin ? "active" : ""}`}
                onClick={() => void beginSetup()}
                disabled={!canBegin || busy}
              >
                Create recovery kit
              </button>
              <button
                type="button"
                className={`settings-pill ${recoveryKit ? "active" : ""}`}
                data-debug-id="shellx-vault-recovery-confirm"
                onClick={() => void confirmRecovery()}
                disabled={!recoveryKit || busy}
              >
                {recoveryKit ? "Save setup and unlock vault" : "Save setup"}
              </button>
            </div>
            <label className="vault-check-row" title="Use OS device credentials to unlock this Vault on this computer">
              <input
                type="checkbox"
                data-debug-id="shellx-vault-remember-device-setup"
                checked={rememberDevice}
                onChange={(event) => setRememberDevice(event.currentTarget.checked)}
              />
              Remember this device
            </label>
          </div>
          {passphraseMismatch && <p className="vault-hint">passphrases do not match</p>}
          {recoveryKit?.words.length ? (
            <div className="vault-recovery-kit">
              <code>{recoveryKit.words.join(" ")}</code>
              <button
                type="button"
                className="settings-pill"
                data-debug-id="shellx-vault-recovery-copy"
                onClick={() => void copyRecoveryKit()}
                disabled={busy}
              >
                Copy recovery words
              </button>
              <label className="vault-check-row">
                <input
                  type="checkbox"
                  checked={importLegacy}
                  onChange={(event) => setImportLegacy(event.currentTarget.checked)}
                />
                Import existing ShellX secrets
              </label>
            </div>
          ) : null}
        </>
      )}
      {message && <p className="vault-hint">{message}</p>}
    </section>
  );
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
