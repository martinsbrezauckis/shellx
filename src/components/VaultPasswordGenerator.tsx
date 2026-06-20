import { useEffect, useMemo, useState, type JSX, type MouseEvent } from "react";

import { ShellIcon } from "./icons";
import {
  clearVaultPasswordPocket,
  DEFAULT_VAULT_PASSWORD_OPTIONS,
  ensureVaultPasswordPocket,
  getVaultPasswordPocket,
  normalizeVaultPasswordOptions,
  regenerateVaultPasswordPocket,
  subscribeVaultPasswordPocket,
  VAULT_PASSWORD_POCKET_TTL_MS,
  type VaultPasswordGeneratorOptions,
  type VaultPasswordPocket,
} from "../lib/vault-password-generator";

export function VaultPasswordGenerator({
  title = "Password generator",
  onClose,
  onUsePassword,
  usePasswordLabel = "Use password",
  onSavePassword,
  savePasswordLabel = "Save secret",
  savePasswordDisabled = false,
}: {
  title?: string;
  onClose?: () => void;
  onUsePassword?: (password: string, event?: MouseEvent<HTMLButtonElement>) => void;
  usePasswordLabel?: string;
  onSavePassword?: (password: string, event?: MouseEvent<HTMLButtonElement>) => void;
  savePasswordLabel?: string;
  savePasswordDisabled?: boolean;
}): JSX.Element {
  const [options, setOptions] = useState<VaultPasswordGeneratorOptions>(() =>
    getVaultPasswordPocket()?.options ?? DEFAULT_VAULT_PASSWORD_OPTIONS,
  );
  const [pocket, setPocket] = useState<VaultPasswordPocket>(() => ensureVaultPasswordPocket(options));
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const sync = () => {
      const next = getVaultPasswordPocket();
      if (next) {
        setPocket(next);
        setOptions(next.options);
      }
    };
    return subscribeVaultPasswordPocket(sync);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = getVaultPasswordPocket();
      if (next) {
        setPocket(next);
      } else {
        setPocket(ensureVaultPasswordPocket(options));
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [options]);

  const remainingLabel = useMemo(() => {
    const remainingMs = Math.max(0, pocket.expiresAtMs - Date.now());
    const minutes = Math.floor(remainingMs / 60000);
    const seconds = Math.ceil((remainingMs % 60000) / 1000);
    if (minutes <= 0) return `${Math.max(1, seconds)}s`;
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }, [pocket.expiresAtMs]);

  function patchOptions(patch: Partial<VaultPasswordGeneratorOptions>): void {
    setOptions((prev) => normalizeVaultPasswordOptions({ ...prev, ...patch }));
  }

  function regenerate(): void {
    setPocket(regenerateVaultPasswordPocket(options));
    setCopied(false);
    setRevealed(false);
  }

  async function copy(event?: MouseEvent<HTMLButtonElement>): Promise<void> {
    event?.preventDefault();
    try {
      await navigator.clipboard.writeText(pocket.value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setRevealed(true);
    }
  }

  function clear(): void {
    clearVaultPasswordPocket();
    const next = regenerateVaultPasswordPocket(options);
    setPocket(next);
    setRevealed(false);
    setCopied(false);
  }

  const displayValue = revealed ? pocket.value : maskPassword(pocket.value);

  return (
    <section className="vault-password-generator" data-debug-id="vault-password-generator">
      <div className="vault-password-generator-head">
        <div>
          <h3>{title}</h3>
          <p>Temporary pocket expires in {remainingLabel}.</p>
        </div>
        {onClose && (
          <button
            type="button"
            className="settings-pill"
            onClick={onClose}
            title="Close generator"
            aria-label="Close password generator"
            data-debug-id="vault-password-generator-close"
          >
            <ShellIcon name="close" size={13} />
          </button>
        )}
      </div>
      <div className="vault-password-output">
        <input
          className="settings-input"
          value={displayValue}
          readOnly
          spellCheck={false}
          aria-label="Generated password"
          data-debug-id="vault-password-generator-output"
        />
        <button
          type="button"
          className="settings-pill"
          onClick={() => setRevealed((value) => !value)}
          title={revealed ? "Hide generated password" : "Reveal generated password"}
          aria-label={revealed ? "Hide generated password" : "Reveal generated password"}
        >
          <ShellIcon name={revealed ? "eye-off" : "eye"} size={13} />
        </button>
        <button
          type="button"
          className={`settings-pill ${copied ? "active" : ""}`}
          onClick={(event) => void copy(event)}
          title="Copy generated password"
          aria-label="Copy generated password"
          data-debug-id="vault-password-generator-copy"
        >
          <ShellIcon name={copied ? "check" : "copy"} size={13} />
        </button>
      </div>
      <div className="vault-password-options">
        <label className="vault-password-length">
          <span>Length</span>
          <input
            type="range"
            min={8}
            max={64}
            value={options.length}
            onChange={(event) => patchOptions({ length: Number(event.currentTarget.value) })}
          />
          <input
            className="settings-input"
            type="number"
            min={8}
            max={64}
            value={options.length}
            onChange={(event) => patchOptions({ length: Number(event.currentTarget.value) })}
            aria-label="Password length"
            data-debug-id="vault-password-generator-length"
          />
        </label>
        <div className="vault-password-switches" aria-label="Password character sets">
          <PasswordOption checked={options.lower} label="a-z" onChange={(lower) => patchOptions({ lower })} />
          <PasswordOption checked={options.upper} label="A-Z" onChange={(upper) => patchOptions({ upper })} />
          <PasswordOption checked={options.digits} label="0-9" onChange={(digits) => patchOptions({ digits })} />
          <PasswordOption checked={options.symbols} label="Symbols" onChange={(symbols) => patchOptions({ symbols })} />
        </div>
      </div>
      <div className="vault-password-actions">
        <button
          type="button"
          className="settings-pill active"
          onClick={regenerate}
          data-debug-id="vault-password-generator-regenerate"
        >
          <ShellIcon name="sparkles" size={13} />
          <span>Generate</span>
        </button>
        {onUsePassword && (
          <button
            type="button"
            className="settings-pill"
            onClick={(event) => onUsePassword(pocket.value, event)}
            data-debug-id="vault-password-generator-use"
          >
            {usePasswordLabel}
          </button>
        )}
        {onSavePassword && (
          <button
            type="button"
            className={`settings-pill ${!savePasswordDisabled ? "active" : ""}`}
            onClick={(event) => onSavePassword(pocket.value, event)}
            disabled={savePasswordDisabled}
            data-debug-id="vault-password-generator-save"
          >
            {savePasswordLabel}
          </button>
        )}
        <button type="button" className="settings-pill" onClick={clear}>
          Delete
        </button>
      </div>
      <p className="vault-password-note">
        Kept only in this ShellX window for {Math.round(VAULT_PASSWORD_POCKET_TTL_MS / 60000)} minutes.
      </p>
    </section>
  );
}

function PasswordOption({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className={`vault-password-switch ${checked ? "active" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function maskPassword(value: string): string {
  return "•".repeat(Math.max(12, Math.min(value.length, 32)));
}
