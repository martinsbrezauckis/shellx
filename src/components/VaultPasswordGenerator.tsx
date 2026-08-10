import { useEffect, useMemo, useState, type JSX, type MouseEvent } from "react";

import { ShellIcon } from "./icons";
import "./VaultPasswordGenerator.css";
import {
  clearVaultPasswordPocket,
  DEFAULT_VAULT_PASSWORD_OPTIONS,
  ensureVaultPasswordPocket,
  getVaultPasswordPocket,
  normalizeVaultPasswordOptions,
  OWNED_DEBUG_VAULT_PASSWORD,
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
  debugFixture = null,
}: {
  title?: string;
  onClose?: () => void;
  onUsePassword?: (password: string, event?: MouseEvent<HTMLButtonElement>) => void;
  usePasswordLabel?: string;
  onSavePassword?: (password: string, event?: MouseEvent<HTMLButtonElement>) => void;
  savePasswordLabel?: string;
  savePasswordDisabled?: boolean;
  debugFixture?: "vault-password" | null;
}): JSX.Element {
  const [options, setOptions] = useState<VaultPasswordGeneratorOptions>(() => debugFixture === "vault-password"
    ? DEFAULT_VAULT_PASSWORD_OPTIONS
    : getVaultPasswordPocket()?.options ?? DEFAULT_VAULT_PASSWORD_OPTIONS);
  const [pocket, setPocket] = useState<VaultPasswordPocket>(() => debugFixture === "vault-password"
    ? ownedDebugPocket()
    : ensureVaultPasswordPocket(options));
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [lengthInput, setLengthInput] = useState(() => String(options.length));
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setLengthInput(String(options.length));
  }, [options.length]);

  useEffect(() => {
    if (debugFixture === "vault-password") {
      setPocket(ownedDebugPocket());
      return () => {};
    }
    const sync = () => {
      const next = getVaultPasswordPocket();
      if (next) {
        setPocket(next);
        setOptions(next.options);
        setNowMs(Date.now());
      }
    };
    return subscribeVaultPasswordPocket(sync);
  }, [debugFixture]);

  useEffect(() => {
    if (debugFixture === "vault-password") return () => {};
    const timer = window.setInterval(() => {
      const next = getVaultPasswordPocket();
      if (next) {
        setPocket(next);
      } else {
        setPocket(ensureVaultPasswordPocket(options));
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [debugFixture, options]);

  const remainingLabel = useMemo(() => {
    const remainingMs = Math.max(0, pocket.expiresAtMs - nowMs);
    const minutes = Math.floor(remainingMs / 60000);
    const seconds = Math.ceil((remainingMs % 60000) / 1000);
    if (minutes <= 0) return `${Math.max(1, seconds)}s`;
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }, [nowMs, pocket.expiresAtMs]);

  function patchOptions(patch: Partial<VaultPasswordGeneratorOptions>): void {
    setOptions((prev) => normalizeVaultPasswordOptions({ ...prev, ...patch }));
  }

  function regenerate(): void {
    setPocket(debugFixture === "vault-password" ? ownedDebugPocket() : regenerateVaultPasswordPocket(options));
    setNowMs(Date.now());
    setCopied(false);
    setCopyFailed(false);
    setRevealed(false);
  }

  function commitLengthInput(): void {
    const parsed = Number(lengthInput);
    const length = Number.isFinite(parsed) ? parsed : options.length;
    const normalized = normalizeVaultPasswordOptions({ ...options, length });
    setOptions(normalized);
    setLengthInput(String(normalized.length));
  }

  async function copy(event?: MouseEvent<HTMLButtonElement>): Promise<void> {
    event?.preventDefault();
    try {
      await navigator.clipboard.writeText(pocket.value);
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  function clear(): void {
    if (debugFixture === "vault-password") {
      setPocket(ownedDebugPocket());
      setRevealed(false);
      setCopied(false);
      setCopyFailed(false);
      return;
    }
    clearVaultPasswordPocket();
    const next = regenerateVaultPasswordPocket(options);
    setPocket(next);
    setNowMs(Date.now());
    setRevealed(false);
    setCopied(false);
    setCopyFailed(false);
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
          onClick={() => {
            setCopyFailed(false);
            setRevealed((value) => !value);
          }}
          title={revealed ? "Hide generated password" : "Reveal generated password"}
          aria-label={revealed ? "Hide generated password" : "Reveal generated password"}
          data-shellx-release-observe="title"
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
      {copyFailed && (
        <p className="vault-password-note" role="status">
          Clipboard access was unavailable. Use Reveal only if you want to copy the password manually.
        </p>
      )}
      <div className="vault-password-options">
        <label className="vault-password-length">
          <span>Length</span>
          <input
            data-debug-id="surface-components-vaultpasswordgenerator-5"
            data-shellx-release-observe="value"
            type="range"
            min={8}
            max={64}
            value={options.length}
            aria-label="Password length slider"
            onChange={(event) => patchOptions({ length: Number(event.currentTarget.value) })}
          />
          <input
            className="settings-input"
            type="number"
            min={8}
            max={64}
            value={lengthInput}
            onChange={(event) => setLengthInput(event.currentTarget.value)}
            onBlur={commitLengthInput}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitLengthInput();
                event.currentTarget.select();
              } else if (event.key === "Escape") {
                setLengthInput(String(options.length));
                event.currentTarget.blur();
              }
            }}
            aria-label="Password length"
            data-debug-id="vault-password-generator-length"
            data-shellx-release-observe="value"
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
          Replace
        </button>
      </div>
      <p className="vault-password-note">
        Kept only in this ShellX window for {Math.round(VAULT_PASSWORD_POCKET_TTL_MS / 60000)} minutes.
      </p>
    </section>
  );
}

function ownedDebugPocket(now = Date.now()): VaultPasswordPocket {
  return {
    value: OWNED_DEBUG_VAULT_PASSWORD,
    createdAtMs: now,
    expiresAtMs: now + VAULT_PASSWORD_POCKET_TTL_MS,
    options: DEFAULT_VAULT_PASSWORD_OPTIONS,
  };
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
        data-debug-id="surface-components-vaultpasswordgenerator-11"
        data-shellx-release-observe="checked"
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
