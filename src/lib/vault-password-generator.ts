export interface VaultPasswordGeneratorOptions {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
}

export interface VaultPasswordPocket {
  value: string;
  createdAtMs: number;
  expiresAtMs: number;
  options: VaultPasswordGeneratorOptions;
}

export const VAULT_PASSWORD_POCKET_TTL_MS = 10 * 60 * 1000;
export const OWNED_DEBUG_VAULT_PASSWORD = "Sx035-owned-disposable!";

export const DEFAULT_VAULT_PASSWORD_OPTIONS: VaultPasswordGeneratorOptions = {
  length: 24,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
};

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*_-+=?";
const EVENT_NAME = "shellx:vault-password-pocket";

let pocket: VaultPasswordPocket | null = null;

export function normalizeVaultPasswordOptions(
  options: Partial<VaultPasswordGeneratorOptions> = {},
): VaultPasswordGeneratorOptions {
  const next: VaultPasswordGeneratorOptions = {
    ...DEFAULT_VAULT_PASSWORD_OPTIONS,
    ...options,
  };
  next.length = Math.min(64, Math.max(8, Math.round(Number(next.length) || DEFAULT_VAULT_PASSWORD_OPTIONS.length)));
  if (!next.lower && !next.upper && !next.digits && !next.symbols) {
    next.lower = true;
  }
  return next;
}

export function generateVaultPassword(
  options: Partial<VaultPasswordGeneratorOptions> = {},
): string {
  const normalized = normalizeVaultPasswordOptions(options);
  const groups = [
    normalized.lower ? LOWER : "",
    normalized.upper ? UPPER : "",
    normalized.digits ? DIGITS : "",
    normalized.symbols ? SYMBOLS : "",
  ].filter(Boolean);
  const all = groups.join("");
  const length = Math.max(normalized.length, groups.length);
  const bytes = new Uint32Array(length + groups.length);
  crypto.getRandomValues(bytes);
  const chars = groups.map((group, index) => group[(bytes[index] ?? 0) % group.length] ?? group[0]);
  for (let index = chars.length; index < length; index += 1) {
    chars.push(all[(bytes[index] ?? 0) % all.length] ?? all[0]);
  }
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = (bytes[index] ?? 0) % (index + 1);
    const current = chars[index];
    const target = chars[swap];
    if (current === undefined || target === undefined) continue;
    chars[index] = target;
    chars[swap] = current;
  }
  return chars.join("");
}

export function getVaultPasswordPocket(now = Date.now()): VaultPasswordPocket | null {
  if (!pocket) return null;
  if (pocket.expiresAtMs <= now) {
    pocket = null;
    emitPocketChanged();
    return null;
  }
  return pocket;
}

export function ensureVaultPasswordPocket(
  options: Partial<VaultPasswordGeneratorOptions> = {},
  now = Date.now(),
): VaultPasswordPocket {
  const existing = getVaultPasswordPocket(now);
  if (existing) return existing;
  return regenerateVaultPasswordPocket(options, now);
}

export function regenerateVaultPasswordPocket(
  options: Partial<VaultPasswordGeneratorOptions> = {},
  now = Date.now(),
): VaultPasswordPocket {
  const normalized = normalizeVaultPasswordOptions(options);
  pocket = {
    value: generateVaultPassword(normalized),
    createdAtMs: now,
    expiresAtMs: now + VAULT_PASSWORD_POCKET_TTL_MS,
    options: normalized,
  };
  emitPocketChanged();
  return pocket;
}

export function clearVaultPasswordPocket(): void {
  pocket = null;
  emitPocketChanged();
}

export function subscribeVaultPasswordPocket(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}

function emitPocketChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}
